/**
 * Send-path benchmark.
 *
 * Repeats POST /api/comments against a running backend and reports p50/p95 for
 * every timing the pipeline exposes:
 *
 *   elapsedMs   - this script -> backend response (script + backend + provider call)
 *   providerMs  - backend send start -> provider acceptance
 *   appearedMs  - backend send start -> comment observed in the room (SSE echo)
 *
 * It does NOT measure TikTok's own display delay beyond the echo, nor the time
 * a human spends typing. Dry-run backends report providerMs=null and produce no
 * echo, so those columns show as n/a.
 *
 * Usage:
 *   npm run benchmark
 *   npx tsx send-benchmark.ts --url http://127.0.0.1:3001 --runs 20 --gap 2100 \
 *     --unique someone --content "123" --token <APP_TOKEN>
 *
 * Keep --gap at or above the backend's SEND_MIN_INTERVAL_MS (default 2000) or
 * the extra runs come back as 429 rate_limited instead of timings.
 */

import { readFileSync } from 'node:fs';

type Args = Record<string, string | boolean>;

interface EchoEvent {
    requestId: string;
    confirmed: boolean;
    appearedMs: number | null;
    echoReason: string | null;
}

function parseArgs(argv: string[]): Args {
    const args: Args = {};
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (!token.startsWith('--')) continue;
        const key = token.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
            args[key] = true;
        } else {
            args[key] = next;
            i += 1;
        }
    }
    return args;
}

function argString(args: Args, key: string, fallback: string): string {
    const value = args[key];
    return typeof value === 'string' ? value : fallback;
}

function loadToken(args: Args): string | null {
    const explicit = argString(args, 'token', '');
    if (explicit !== '') return explicit;
    if (process.env.APP_TOKEN) return process.env.APP_TOKEN;

    // Fall back to the backend's own env file so `npm run benchmark` works
    // without exporting anything.
    try {
        const match = /^APP_TOKEN=(.*)$/m.exec(readFileSync('server/.env', 'utf8'));
        if (match !== null) return match[1].trim();
    } catch {
        // No local env file; the caller reports the missing token.
    }
    return null;
}

function percentile(values: number[], p: number): number {
    const sorted = [...values].sort((a, b) => a - b);
    if (sorted.length === 0) return Number.NaN;
    const index = Math.max(0, Math.ceil(p * sorted.length) - 1);
    return sorted[index];
}

function stats(values: number[]): string {
    if (values.length === 0) return 'n/a (no samples)';
    const sum = values.reduce((total, value) => total + value, 0);
    return `p50 ${percentile(values, 0.50).toFixed(1)}  `
        + `p95 ${percentile(values, 0.95).toFixed(1)}  `
        + `max ${Math.max(...values).toFixed(1)}  `
        + `mean ${(sum / values.length).toFixed(1)}  `
        + `(n=${values.length})`;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
    });
}

/**
 * Follow the backend's echo stream and record every event by requestId.
 * Resolves once the stream is open (or after reporting why it is not).
 */
async function openEchoStream(
    url: string,
    headers: Record<string, string>,
    events: Map<string, EchoEvent>,
    abort: AbortController
): Promise<void> {
    try {
        const response = await fetch(`${url}/api/comments/events`, {
            headers,
            signal: abort.signal
        });
        if (!response.ok || response.body === null) {
            console.error(`[echo] SSE unavailable (HTTP ${response.status}); benchmarking without echo.`);
            return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        void (async () => {
            try {
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done) return;
                    buffer += decoder.decode(value, { stream: true });

                    let index = buffer.indexOf('\n\n');
                    while (index >= 0) {
                        const block = buffer.slice(0, index);
                        buffer = buffer.slice(index + 2);
                        const line = block.split('\n').find((candidate) => candidate.startsWith('data: '));
                        if (line !== undefined) {
                            try {
                                const event = JSON.parse(line.slice('data: '.length)) as EchoEvent;
                                events.set(event.requestId, event);
                            } catch {
                                // Ignore a torn frame; the next block carries the full event.
                            }
                        }
                        index = buffer.indexOf('\n\n');
                    }
                }
            } catch {
                // Stream closed at the end of the run; results are already collected.
            }
        })();
    } catch (error) {
        console.error(`[echo] SSE unavailable (${(error as Error).message}); benchmarking without echo.`);
    }
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));

    const url = argString(args, 'url', process.env.BENCH_URL ?? 'http://127.0.0.1:3001').replace(/\/+$/, '');
    const token = loadToken(args);
    const uniqueId = argString(args, 'unique', process.env.BENCH_UNIQUE ?? '');

    if (token === null) {
        console.error('No APP_TOKEN: pass --token, export APP_TOKEN, or create server/.env.');
        process.exitCode = 1;
        return;
    }
    if (uniqueId === '') {
        console.error('Missing --unique <tiktok handle> (the channel to target).');
        process.exitCode = 1;
        return;
    }

    const content = argString(args, 'content', process.env.BENCH_CONTENT ?? 'benchmark');
    const runs = Number(argString(args, 'runs', '20'));
    const gapMs = Number(argString(args, 'gap', '2100'));
    const timeoutMs = Number(argString(args, 'timeout', '15000'));
    const echoWaitMs = Number(argString(args, 'echo-wait', '12000'));
    const useEcho = !('no-echo' in args);

    if (!Number.isFinite(runs) || runs < 1 || !Number.isFinite(gapMs) || gapMs < 0) {
        console.error('--runs must be >= 1 and --gap must be >= 0.');
        process.exitCode = 1;
        return;
    }

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
    };

    console.log(`Send benchmark against ${url}`);
    console.log(`  target=@${uniqueId} content=${JSON.stringify(content)} runs=${runs} gap=${gapMs}ms timeout=${timeoutMs}ms`);

    // Warm the room cache so the first run does not pay for the room lookup
    // alone; every later run then measures a cached path, like the app does.
    try {
        const prewarm = await fetch(`${url}/api/rooms/prewarm`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ uniqueId }),
            signal: AbortSignal.timeout(timeoutMs)
        });
        const body: any = await prewarm.json().catch(() => null);
        console.log(`  prewarm: HTTP ${prewarm.status}${body?.isLive !== undefined ? ` isLive=${body.isLive}` : ''}`);
    } catch (error) {
        console.log(`  prewarm: skipped (${(error as Error).message})`);
    }

    const echoEvents = new Map<string, EchoEvent>();
    const echoAbort = new AbortController();
    if (useEcho) await openEchoStream(url, headers, echoEvents, echoAbort);

    const elapsed: number[] = [];
    const backend: number[] = [];
    const provider: number[] = [];
    const appeared: number[] = [];
    const sent: Array<{ requestId: string; at: number }> = [];
    const failures: string[] = [];
    let rateLimited = 0;
    let dryRun: boolean | null = null;

    for (let run = 1; run <= runs; run++) {
        const started = Date.now();
        try {
            const response = await fetch(`${url}/api/comments`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ uniqueId, content }),
                signal: AbortSignal.timeout(timeoutMs)
            });
            const elapsedMs = Date.now() - started;
            const body: any = await response.json().catch(() => null);

            if (response.status === 429) {
                rateLimited += 1;
                failures.push(`run ${run}: 429 rate_limited (gap ${gapMs}ms is below the backend limit)`);
            } else if (response.status !== 200 || body === null || body.ok !== true) {
                failures.push(`run ${run}: HTTP ${response.status} ${body?.code ?? ''} ${body?.error ?? ''}`.trim());
            } else {
                elapsed.push(elapsedMs);
                dryRun = body.dryRun === true;
                if (typeof body.backendMs === 'number') backend.push(body.backendMs);
                if (typeof body.providerMs === 'number') provider.push(body.providerMs);
                sent.push({ requestId: body.requestId, at: started });
            }

            console.log(`  ${String(run).padStart(String(runs).length)}/${runs}  HTTP ${response.status}  ${elapsedMs.toFixed(1)} ms`);
        } catch (error) {
            failures.push(`run ${run}: ${(error as Error).message}`);
            console.log(`  ${String(run).padStart(String(runs).length)}/${runs}  ERROR  ${(error as Error).message}`);
        }

        if (run < runs) await sleep(gapMs);
    }

    // Give the echo stream time to report the sent comments; a dry-run backend
    // never publishes echo events, so do not wait for them.
    let confirmed = 0;
    let echoTimeouts = 0;
    if (dryRun !== true && useEcho) {
        await sleep(echoWaitMs);
    }
    for (const { requestId } of sent) {
        const event = echoEvents.get(requestId);
        if (event !== undefined && typeof event.appearedMs === 'number') {
            appeared.push(event.appearedMs);
            if (event.confirmed) confirmed += 1;
            else echoTimeouts += 1;
        } else {
            echoTimeouts += 1;
        }
    }
    echoAbort.abort();

    console.log('');
    console.log(`Results — ${sent.length}/${runs} sent`
        + `${dryRun === true ? ' (dry-run: provider/echo timings are n/a)' : ''}`);
    console.log(`  elapsedMs   ${stats(elapsed)}`);
    console.log(`  backendMs   ${stats(backend)}`);
    console.log(`  providerMs  ${stats(provider)}`);
    console.log(`  appearedMs  ${stats(appeared)}`);
    if (dryRun !== true && useEcho) {
        console.log(`  echo: ${confirmed} confirmed, ${echoTimeouts} without a seen comment`);
    }
    if (rateLimited > 0) console.log(`  rate-limited: ${rateLimited}`);
    if (failures.length > 0) {
        console.log(`  failures (${failures.length}):`);
        for (const failure of failures) console.log(`    ${failure}`);
        process.exitCode = 1;
    }
}

void main();