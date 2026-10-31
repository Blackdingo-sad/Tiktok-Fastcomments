import http from 'node:http';

import { TikTokLiveConnection } from './src/index';
import { ControlEvent, WebcastEvent } from './src/types/events';
import type { WebcastChatMessage } from './src/types/tiktok-schema';
import {
    correlateSendMarker,
    hashComment,
    isSendMarker,
    type SendMarker
} from './server/measurement';

/**
 * Read-only LIVE chat monitor for the operator.
 *
 * It only reads the public chat: no session cookies, no sending, no retry against TikTok.
 * The point is to make the announced price or code easy to notice, not to make TikTok deliver
 * anything faster. The clock shown is when this machine received the comment, not when other
 * viewers saw it.
 *
 * Usage:
 *   npx tsx watch-live.ts <handle-or-live-url> [--keywords "199k,giá,sp"] [--port 8787]
 *       [--sender <sender-username>]
 *   npx tsx watch-live.ts --demo [--keywords "199k"] [--port 8787]
 */

type Status = 'connecting' | 'live' | 'offline' | 'error';

const MAX_COMMENTS = 100;
const HEARTBEAT_MS = 15_000;

interface Options {
    target: string | null;
    keywords: string[];
    port: number;
    demo: boolean;
    senderUniqueId: string | null;
}

interface MeasurementView {
    sendId: string;
    elapsedMs: number;
}

interface CommentView {
    id: number;
    user: string;
    text: string;
    hits: string[];
    at: number;
    measurement?: MeasurementView;
}

let status: Status = 'connecting';
let statusDetail = '';
let handle = '';
let activeKeywords: string[] = [];
let lastErrorDetail = '';
const comments: CommentView[] = [];
const commentHashes = new Map<number, string>();
const sendMarkers: SendMarker[] = [];
const clients = new Set<http.ServerResponse>();
let nextId = 1;

function describeError(error: unknown): string {
    if (error instanceof Error) {
        return error.message.trim() === '' ? error.name : `${error.name}: ${error.message}`;
    }
    if (typeof error === 'object' && error !== null) {
        const record = error as Record<string, unknown>;
        for (const key of ['message', 'error', 'msg']) {
            const value = record[key];
            if (typeof value === 'string' && value.trim() !== '') return value;
        }
        const entries = Object.entries(record)
            .slice(0, 6)
            .map(([key, value]) => `${key}=${typeof value === 'object' ? '[obj]' : String(value)}`);
        if (entries.length > 0) return `{ ${entries.join(', ')} }`;
    }
    return String(error);
}

function normalize(value: string): string {
    return value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd')
        .replace(/Đ/g, 'D')
        .toLowerCase();
}

function matchedKeywords(text: string, keywords: string[]): string[] {
    if (keywords.length === 0) return [];
    const haystack = normalize(text);
    return keywords.filter((keyword) => haystack.includes(normalize(keyword)));
}

function broadcast(event: string, payload: unknown): void {
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of clients) client.write(frame);
}

function setStatus(next: Status, detail = ''): void {
    status = next;
    statusDetail = detail;
    broadcast('state', { status, detail, handle, keywords: activeKeywords });
}

function addComment(user: string, text: string, keywords: string[]): void {
    const view: CommentView = {
        id: nextId++,
        user,
        text,
        hits: matchedKeywords(text, keywords),
        at: Date.now()
    };
    comments.unshift(view);
    if (optionsSenderUniqueId !== null) commentHashes.set(view.id, hashComment(text));
    if (comments.length > MAX_COMMENTS) {
        const removed = comments.pop();
        if (removed !== undefined) commentHashes.delete(removed.id);
    }
    broadcast('chat', view);
    matchMeasurements();
    if (view.hits.length > 0) console.log(`KHỚP "${view.hits.join(', ')}": ${user}: ${text}`);
}

function matchMeasurements(): void {
    const senderUniqueId = optionsSenderUniqueId;
    if (senderUniqueId === null) return;

    for (const marker of sendMarkers) {
        const match = [...comments].reverse()
            .filter((item) => item.measurement === undefined)
            .map((item) => ({
                comment: item,
                result: commentHashes.get(item.id) === marker.contentHash
                    ? correlateSendMarker(marker, {
                        user: item.user,
                        text: item.text,
                        receivedAtMs: item.at
                    }, senderUniqueId)
                    : null
            }))
            .find((item) => item.result !== null);
        if (match === undefined || match.result === null) continue;
        match.comment.measurement = match.result;
        broadcast('measurement', {
            commentId: match.comment.id,
            measurement: match.comment.measurement
        });
        console.log(`[measure] @${match.comment.user} comment observer nhận sau ${match.result.elapsedMs} ms`);
    }
}

let optionsSenderUniqueId: string | null = null;

const PAGE = `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Live Comment Watch</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #12100f; color: #f4efe9; font: 16px/1.45 system-ui, -apple-system, Segoe UI, sans-serif; }
  header { position: sticky; top: 0; display: flex; gap: 14px; align-items: center;
           padding: 12px 16px; background: #1c1917; border-bottom: 1px solid #332e2a; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: #8a817c; flex: none; }
  .dot.live { background: #34d399; }
  .dot.error { background: #f87171; }
  .dot.offline { background: #fbbf24; }
  #handle { font-weight: 600; }
  .meta { color: #a8a29e; font-size: 13px; margin-left: auto; }
  button { background: #2a2523; color: #f4efe9; border: 1px solid #443c38; border-radius: 8px;
           padding: 8px 12px; font-size: 13px; cursor: pointer; }
  button.on { background: #34d399; border-color: #34d399; color: #12100f; font-weight: 700; }
  main { padding: 10px 16px 60px; }
  .row { display: flex; gap: 12px; padding: 9px 12px; border-radius: 10px; border-left: 3px solid transparent; }
  .row.hit { background: #2b1a12; border-left-color: #fb923c; }
  .row.hit .text { font-size: 26px; font-weight: 700; color: #fed7aa; }
  .time { color: #78716c; font-size: 12px; font-variant-numeric: tabular-nums; padding-top: 3px; min-width: 96px; }
  .user { color: #a8a29e; min-width: 120px; }
  .text { white-space: pre-wrap; word-break: break-word; }
  .delta { color: #86efac; font: 12px ui-monospace, "Cascadia Mono", Consolas, monospace; white-space: nowrap; }
  footer { position: fixed; bottom: 0; left: 0; right: 0; padding: 8px 16px; background: #1c1917;
           border-top: 1px solid #332e2a; color: #78716c; font-size: 12px; }
  mark { background: #fb923c; color: #12100f; padding: 0 2px; border-radius: 3px; }
</style>
</head>
<body>
<header>
  <div id="dot" class="dot"></div>
  <span id="handle">dang ket noi...</span>
  <span id="state" class="meta"></span>
  <button id="sound">Bat am thanh</button>
</header>
<main id="feed"></main>
<footer>Δ là thời gian từ lúc app nhấn Enter đến lúc observer trên máy này nhận comment. Đây không phải thời điểm TikTok phân phối tới mọi người xem.</footer>
<script>
(function () {
  var feed = document.getElementById('feed');
  var dot = document.getElementById('dot');
  var handleEl = document.getElementById('handle');
  var stateEl = document.getElementById('state');
  var soundBtn = document.getElementById('sound');
  var audio = null;
  var lastBeep = 0;
  var total = 0;
  var hits = 0;

  soundBtn.addEventListener('click', function () {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!audio) audio = new Ctx();
    audio.resume();
    soundBtn.classList.add('on');
    soundBtn.textContent = 'Am thanh bat';
  });

  function beep() {
    if (!audio || audio.state !== 'running') return;
    var now = Date.now();
    if (now - lastBeep < 600) return;
    lastBeep = now;
    var osc = audio.createOscillator();
    var gain = audio.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.22, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.25);
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 0.26);
  }

  function clock(at) {
    var d = new Date(at);
    function pad(n, w) { return String(n).padStart(w || 2, '0'); }
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '.' + pad(d.getMilliseconds(), 3);
  }

  function markHits(text, hits) {
    var span = document.createElement('span');
    if (!hits.length) { span.textContent = text; return span; }
    var lower = text.toLowerCase();
    var ranges = [];
    hits.forEach(function (hit) {
      var needle = hit.toLowerCase();
      if (!needle) return;
      var from = 0;
      while (from <= lower.length) {
        var at = lower.indexOf(needle, from);
        if (at === -1) break;
        ranges.push([at, at + needle.length]);
        from = at + needle.length;
      }
    });
    ranges.sort(function (a, b) { return a[0] - b[0]; });
    var cursor = 0;
    ranges.forEach(function (range) {
      if (range[0] < cursor) return;
      if (range[0] > cursor) span.appendChild(document.createTextNode(text.slice(cursor, range[0])));
      var mark = document.createElement('mark');
      mark.textContent = text.slice(range[0], range[1]);
      span.appendChild(mark);
      cursor = range[1];
    });
    if (cursor < text.length) span.appendChild(document.createTextNode(text.slice(cursor)));
    return span;
  }

  function render(item) {
    total += 1;
    if (item.hits.length) hits += 1;
    var row = document.createElement('div');
    row.className = 'row' + (item.hits.length ? ' hit' : '');
    var time = document.createElement('div');
    time.className = 'time';
    time.textContent = clock(item.at);
    var user = document.createElement('div');
    user.className = 'user';
    user.textContent = item.user;
    var text = document.createElement('div');
    text.className = 'text';
    text.appendChild(markHits(item.text, item.hits));
    if (item.measurement) {
      var delta = document.createElement('span');
      delta.className = 'delta';
      delta.textContent = '  Δ ' + item.measurement.elapsedMs + ' ms';
      text.appendChild(delta);
    }
    row.dataset.commentId = String(item.id);
    row.appendChild(time);
    row.appendChild(user);
    row.appendChild(text);
    feed.insertBefore(row, feed.firstChild);
    while (feed.childNodes.length > 100) feed.removeChild(feed.lastChild);
    stateEl.textContent = total + ' comment · ' + hits + ' khop';
    if (item.hits.length) beep();
  }

  function setStatus(payload) {
    var cls = payload.status === 'live' ? 'live' : payload.status === 'error' ? 'error' : 'offline';
    dot.className = 'dot ' + cls;
    handleEl.textContent = payload.handle ? '@' + payload.handle : 'chua co LIVE';
    if (payload.detail) stateEl.textContent = payload.detail;
  }

  var source = new EventSource('/events');
  source.addEventListener('state', function (event) { setStatus(JSON.parse(event.data)); });
  source.addEventListener('chat', function (event) { render(JSON.parse(event.data)); });
  source.addEventListener('measurement', function (event) {
    var payload = JSON.parse(event.data);
    var row = feed.querySelector('[data-comment-id="' + payload.commentId + '"]');
    if (!row || row.querySelector('.delta')) return;
    var delta = document.createElement('span');
    delta.className = 'delta';
    delta.textContent = '  Δ ' + payload.measurement.elapsedMs + ' ms';
    row.querySelector('.text').appendChild(delta);
  });
})();
</script>
</body>
</html>`;

function startServer(options: Options): http.Server {
    const server = http.createServer((request, response) => {
        const url = request.url ?? '/';
        if (url === '/measurement/send') {
            if (request.method !== 'POST' || options.senderUniqueId === null) {
                response.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
                response.end(JSON.stringify({ ok: false, error: 'measurement_not_enabled' }));
                return;
            }
            if (!/^application\/json\b/i.test(request.headers['content-type'] ?? '')) {
                response.writeHead(415, { 'Content-Type': 'application/json; charset=utf-8' });
                response.end(JSON.stringify({ ok: false, error: 'json_required' }));
                request.resume();
                return;
            }

            const chunks: Buffer[] = [];
            let size = 0;
            request.on('data', (chunk: Buffer) => {
                size += chunk.length;
                if (size <= 2_048) chunks.push(chunk);
            });
            request.on('end', () => {
                if (size > 2_048) {
                    response.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
                    response.end(JSON.stringify({ ok: false, error: 'body_too_large' }));
                    return;
                }
                let payload: unknown;
                try {
                    payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                } catch {
                    response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    response.end(JSON.stringify({ ok: false, error: 'invalid_json' }));
                    return;
                }
                if (!isSendMarker(payload) || payload.sentAtMs > Date.now() + 1_000
                    || Date.now() - payload.sentAtMs > 30_000) {
                    response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    response.end(JSON.stringify({ ok: false, error: 'invalid_or_stale_marker' }));
                    return;
                }

                sendMarkers.push(payload);
                while (sendMarkers.length > MAX_COMMENTS) sendMarkers.shift();
                matchMeasurements();
                response.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8' });
                response.end(JSON.stringify({ ok: true }));
            });
            return;
        }
        if (url === '/events') {
            response.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive'
            });
            clients.add(response);
            response.write(
                `event: state\ndata: ${JSON.stringify({ status, detail: statusDetail, handle })}\n\n`
            );
            for (const comment of [...comments].reverse()) {
                response.write(`event: chat\ndata: ${JSON.stringify(comment)}\n\n`);
            }
            request.on('close', () => clients.delete(response));
            return;
        }
        if (url === '/' || url === '/index.html') {
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            response.end(PAGE);
            return;
        }
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('not found');
    });

    const heartbeat = setInterval(() => {
        for (const client of clients) client.write(': ping\n\n');
    }, HEARTBEAT_MS);
    heartbeat.unref();

    server.listen(options.port, '127.0.0.1', () => {
        console.log(`màn hình: http://127.0.0.1:${options.port}/  (Ctrl+C để dừng)`);
    });
    return server;
}

function parseKeywords(raw: string): string[] {
    return raw
        .split(',')
        .map((keyword) => keyword.trim())
        .filter((keyword) => keyword.length > 0);
}

function parseArgs(argv: string[]): Options {
    const options: Options = {
        target: null,
        keywords: [],
        port: 8787,
        demo: false,
        senderUniqueId: null
    };
    const rest: string[] = [];
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--keywords') {
            options.keywords = parseKeywords(argv[index + 1] ?? '');
            index += 1;
        } else if (arg === '--port') {
            const port = Number(argv[index + 1]);
            if (!Number.isInteger(port) || port < 1 || port > 65_535) {
                throw new Error('--port phải là số từ 1 đến 65535');
            }
            options.port = port;
            index += 1;
        } else if (arg === '--demo') {
            options.demo = true;
        } else if (arg === '--sender') {
            const sender = (argv[index + 1] ?? '').trim().replace(/^@/, '').toLowerCase();
            if (!/^[a-z0-9._]{1,24}$/.test(sender)) {
                throw new Error('--sender phải là username TikTok hợp lệ.');
            }
            options.senderUniqueId = sender;
            index += 1;
        } else if (arg.startsWith('--')) {
            throw new Error(`tham số không rõ: ${arg}`);
        } else {
            rest.push(arg);
        }
    }
    options.target = rest[0] ?? null;
    if (options.senderUniqueId !== null && options.port !== 8787) {
        throw new Error('Đo đồng bộ với app yêu cầu cổng 8787.');
    }
    return options;
}

function extractHandle(target: string): string {
    return target
        .replace(/^https?:\/\/(www\.)?tiktok\.com\//i, '')
        .replace(/\/live.*$/i, '')
        .replace(/^@/, '')
        .trim();
}

function startDemo(keywords: string[]): void {
    handle = 'demo';
    setStatus('live', 'chế độ demo: không kết nối TikTok');
    const samples = [
        ['nguoi_mua_01', 'còn hàng không shop'],
        ['nguoi_mua_02', 'giá 199k đúng không ạ'],
        ['nguoi_mua_03', 'chốt 1 cái'],
        ['nguoi_mua_04', 'ship về hà nội mấy hôm']
    ];
    let index = 0;
    setInterval(() => {
        const [user, text] = samples[index % samples.length];
        index += 1;
        addComment(user, `${text} (${index})`, keywords);
    }, 1_500);
}

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    activeKeywords = options.keywords;
    optionsSenderUniqueId = options.senderUniqueId;
    startServer(options);

    if (options.demo) {
        startDemo(options.keywords);
        return;
    }

    if (options.target === null) {
        throw new Error('thiếu handle hoặc link LIVE. Ví dụ: npx tsx watch-live.ts @mtien0044 --keywords "199k"');
    }

    handle = extractHandle(options.target);
    setStatus('connecting', 'đang tìm phòng LIVE…');

    const connection = new TikTokLiveConnection(handle, {
        fetchRoomInfoOnConnect: false,
        processInitialData: false,
        enableRequestPolling: false
    });

    connection.on(ControlEvent.ERROR, (error: unknown) => {
        const detail = describeError(error);
        lastErrorDetail = detail;
        console.error(`lỗi kết nối: ${detail}`);
        setStatus('error', detail.slice(0, 160));
    });

    connection.on(WebcastEvent.STREAM_END, () => {
        console.log('LIVE đã kết thúc.');
        setStatus('offline', 'LIVE đã kết thúc');
    });

    connection.on(ControlEvent.DISCONNECTED, () => {
        console.log('mất kết nối tới chat, không tự kết nối lại.');
        setStatus('offline', 'mất kết nối tới chat');
    });

    connection.on(WebcastEvent.CHAT, (data: WebcastChatMessage) => {
        addComment(data.user?.uniqueId ?? 'ẩn danh', data.comment ?? '', options.keywords);
    });

    let roomId: string;
    try {
        roomId = await connection.fetchRoomId(handle);
    } catch (error: unknown) {
        // The room lookup rejects with a bare Error; the useful reason arrives through the error event.
        const cause = describeError(error);
        const detail = cause === 'Error' && lastErrorDetail !== '' ? lastErrorDetail : cause;
        throw new Error(
            `không lấy được phòng LIVE của @${handle}: ${detail}. ` +
                'Kiểm tra lại handle, hoặc LIVE đang tắt.'
        );
    }


    const isLive = await connection.fetchIsLive();
    if (!isLive) {
        console.log(`@${handle} hiện không phát LIVE. Màn hình vẫn mở (Ctrl+C để dừng).`);
        setStatus('offline', 'LIVE đang tắt');
        return;
    }

    await connection.connect(roomId);
    setStatus('live', 'đang theo dõi chat');
    console.log(`đang theo dõi chat của @${handle}. Từ khoá: ${options.keywords.join(', ') || '(chưa đặt)'}`);
    if (options.senderUniqueId !== null) {
        console.log(`đo đồng bộ bật cho @${options.senderUniqueId}; app và observer phải chạy trên cùng máy.`);
    }
}

main().catch((error: unknown) => {
    console.error(`không chạy được: ${error instanceof Error ? error.message : describeError(error)}`);
    process.exit(1);
});
