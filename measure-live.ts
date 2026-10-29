import fs from 'node:fs';
import http from 'node:http';

/**
 * Sends real comments through the running backend and reports the delay until
 * each one comes back through the LIVE chat.
 *
 * Usage (backend must be running, with SEND_DRY_RUN=0 and a logged-in session):
 *   npx tsx measure-live.ts <handle-or-live-url> --count 5 [--interval 3000]
 *       [--text "giá 199k"] [--exact] [--yes]
 *
 * Without --exact a short numeric tag is appended to each comment so an echo
 * can be matched reliably; with --exact the text is sent unchanged and the
 * match may be ambiguous if another viewer posts the same words.
 *
 * "appearedMs" is the time from pressing send to the comment showing up in the
 * room's chat stream. It is NOT a queue position: TikTok does not expose one,
 * and the metric cannot say anything about other viewers' comments.
 */

const BASE = process.env.BACKEND_URL ?? 'http://127.0.0.1:3001';
const ECHO_TIMEOUT_MS = 12_000;

interface SendResult {
    requestId: string;
    content: string;
    ackMs: number;
    providerMs: number | null;
}

interface EchoEvent {
    requestId: string;
    confirmed: boolean;
    appearedMs: number | null;
    echoReason: string | null;
}

function readToken(): string {
    const raw = fs.readFileSync('server/.env', 'utf8');
    const line = raw.split(/\r?\n/).find((entry) => entry.startsWith('APP_TOKEN='));
    if (line === undefined) throw new Error('APP_TOKEN không có trong server/.env');
    const token = line.slice('APP_TOKEN='.length).trim();
    if (token === '') throw new Error('APP_TOKEN rỗng trong server/.env');
    return token;
}

function parseArgs(argv: string[]) {
    const options = {
        target: '',
        count: 5,
        intervalMs: 3000,
        text: 'test',
        exact: false,
        yes: false
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--yes') options.yes = true;
        else if (arg === '--exact') options.exact = true;
        else if (arg === '--count') options.count = Number(argv[++i]);
        else if (arg === '--interval') options.intervalMs = Number(argv[++i]);
        else if (arg === '--text') options.text = argv[++i];
        else if (!arg.startsWith('--') && options.target === '') options.target = arg;
    }

    if (options.target === '' || !Number.isInteger(options.count) || options.count < 1
        || options.count > 20 || !Number.isFinite(options.intervalMs) || options.intervalMs < 2500) {
        throw new Error('Dùng: npx tsx measure-live.ts <handle|link LIVE> --count 5 --interval 3000 --text "..." --yes');
    }
    if (!options.text || options.text.trim() === '') throw new Error('Thiếu nội dung bình luận (--text).');
    return options;
}

function percentile(values: number[], p: number): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[index];
}

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    const token = readToken();
    const auth = { Authorization: `Bearer ${token}` };

    const health = await (await fetch(`${BASE}/health`, { headers: auth })).json();
    if (health.dryRun === true) {
        console.error('Backend đang ở chế độ thử (SEND_DRY_RUN=1): không có gì được gửi và không có echo để đo.');
        console.error('Đặt SEND_DRY_RUN=0, cấu hình EULER_API_KEY và phiên TikTok, khởi động lại backend rồi chạy lại.');
        process.exit(2);
    }
    if (health.echo !== true) {
        console.error('Xác nhận echo đang tắt trên backend (ECHO_CONFIRM=0); không đo được thời điểm hiện ra.');
        process.exit(2);
    }

    const session = await (await fetch(`${BASE}/api/session`, { headers: auth })).json();
    if (session.configured !== true) {
        console.error('Backend chưa có phiên TikTok: đăng nhập trong app (hoặc dán cookie) rồi chạy lại.');
        process.exit(2);
    }

    const prewarm = await fetch(`${BASE}/api/rooms/prewarm`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ uniqueId: options.target }),
        signal: AbortSignal.timeout(15_000)
    });
    if (!prewarm.ok) {
        console.error(`Không tra được phòng cho ${options.target}: HTTP ${prewarm.status}`);
        process.exit(2);
    }
    const prewarmData = await prewarm.json();
    console.log(`Kênh đích: ${prewarmData.isLive === true ? 'đang LIVE' : prewarmData.isLive === false ? 'OFFLINE' : 'không xác định trạng thái'}`);
    if (prewarmData.isLive === false) {
        console.error('Kênh không LIVE nên không đo được; mở LIVE rồi chạy lại.');
        process.exit(2);
    }

    if (!options.yes) {
        console.error(`Sẽ gửi ${options.count} bình luận thật tới "${options.target}", cách nhau ${options.intervalMs} ms.`);
        console.error('Chạy lại với --yes để thực sự gửi.');
        process.exit(2);
    }

    const echoes = new Map<string, EchoEvent>();
    const waiters = new Map<string, (event: EchoEvent) => void>();

    const stream = http.get(`${BASE}/api/comments/events`, { headers: { ...auth, Accept: 'text/event-stream' } }, (res) => {
        if (res.statusCode !== 200) {
            console.error(`SSE trả về HTTP ${res.statusCode}; không mở được kênh xác nhận.`);
            process.exit(3);
        }
        res.setEncoding('utf8');
        let buffer = '';
        res.on('data', (chunk: string) => {
            buffer += chunk;
            let split = buffer.indexOf('\n\n');
            while (split >= 0) {
                const block = buffer.slice(0, split);
                buffer = buffer.slice(split + 2);
                const data = block.split('\n')
                    .filter((line) => line.startsWith('data: '))
                    .map((line) => line.slice(6))
                    .join('\n');
                if (data !== '') {
                    try {
                        const event = JSON.parse(data) as EchoEvent;
                        if (typeof event.requestId === 'string') {
                            echoes.set(event.requestId, event);
                            const waiter = waiters.get(event.requestId);
                            if (waiter !== undefined) {
                                waiters.delete(event.requestId);
                                waiter(event);
                            }
                        }
                    } catch {
                        // ignore malformed frames
                    }
                }
                split = buffer.indexOf('\n\n');
            }
        });
    });

    await new Promise((resolve) => setTimeout(resolve, 500));
    console.log(`Đo ${options.count} lần gửi tới ${options.target} (${options.intervalMs} ms giữa các lần)\n`);

    const rows: Array<SendResult & { readout: EchoEvent | null }> = [];

    for (let i = 1; i <= options.count; i++) {
        const content = options.exact ? options.text : `${options.text} ${Date.now() % 100000}${i}`;
        const startedAt = performance.now();
        const response = await fetch(`${BASE}/api/comments`, {
            method: 'POST',
            headers: { ...auth, 'Content-Type': 'application/json' },
            body: JSON.stringify({ uniqueId: options.target, content }),
            signal: AbortSignal.timeout(15_000)
        });
        const ackMs = Math.round(performance.now() - startedAt);
        const payload = await response.json();

        if (!response.ok || payload.ok !== true) {
            console.log(`#${i} gửi thất bại: HTTP ${response.status} ${payload.error ?? ''}`.trim());
            continue;
        }

        const requestId = String(payload.requestId);
        const readout = await new Promise<EchoEvent | null>((resolve) => {
            const already = echoes.get(requestId);
            if (already !== undefined) {
                echoes.delete(requestId);
                resolve(already);
                return;
            }
            const timer = setTimeout(() => {
                waiters.delete(requestId);
                resolve(null);
            }, ECHO_TIMEOUT_MS);
            waiters.set(requestId, (event) => {
                clearTimeout(timer);
                echoes.delete(requestId);
                resolve(event);
            });
        });

        rows.push({ requestId, content, ackMs, providerMs: payload.providerMs ?? null, readout });

        if (readout === null) {
            console.log(`#${i} không nhận được kết quả xác nhận trong ${ECHO_TIMEOUT_MS} ms`);
        } else if (readout.confirmed) {
            console.log(`#${i} hiện trên LIVE sau ${readout.appearedMs} ms (backend ack ${ackMs} ms)`);
        } else {
            console.log(`#${i} chưa thấy hiện ra (${readout.echoReason ?? 'không rõ'}), backend ack ${ackMs} ms`);
        }

        if (i < options.count) await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
    }

    stream.destroy();

    const appeared = rows
        .map((row) => (row.readout?.confirmed === true ? row.readout.appearedMs : null))
        .filter((value): value is number => typeof value === 'number');
    const acks = rows.map((row) => row.ackMs);
    const confirmed = appeared.length;

    console.log('\n--- tổng hợp ---');
    console.log(`đã gửi: ${rows.length}/${options.count}, xác nhận hiện ra: ${confirmed}`);
    console.log(`ack backend: p50 ${percentile(acks, 50)} ms, p95 ${percentile(acks, 95)} ms`);
    if (confirmed > 0) {
        console.log(`hiện trên LIVE: p50 ${percentile(appeared, 50)} ms, p95 ${percentile(appeared, 95)} ms, `
            + `min ${Math.min(...appeared)} ms, max ${Math.max(...appeared)} ms`);
    }
    console.log('\nLưu ý: đây là thời gian bình luận của bạn xuất hiện trong chat, không phải vị trí trong hàng đợi.');
    console.log('TikTok không công khai thứ tự xử lý, nên không thể chứng minh bình luận được ưu tiên hơn người khác.');

    process.exit(confirmed > 0 ? 0 : 1);
}

main().catch((error) => {
    console.error('FAILED:', error instanceof Error ? error.message : String(error));
    process.exit(1);
});
