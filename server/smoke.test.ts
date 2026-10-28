import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createCommentServer } from './http';
import { createCommentSender, type CommentSenderDeps, type EchoConfirmerLike } from './comments';
import { EchoHub } from './events';
import { loadConfig, type ServerConfig } from './config';
import { createSessionStore, type SessionStore } from './session';
import { AppError } from './errors';
import type { EchoResult } from './echo';

const baseConfig: ServerConfig = {
    host: '127.0.0.1',
    port: 0,
    accessToken: 'test-token-0123456789',
    dryRun: false,
    echoEnabled: false,
    echoTimeoutMs: 1_000,
    echoIdleMs: 5_000,
    sendIntervalMs: 0,
    sendMaxPerMinute: 100,
    roomCacheTtlMs: 60_000,
    providerTimeoutMs: 2_000,
    eulerApiKey: 'euler-key',
    sendProvider: 'webcast',
    tiktokSessionId: 'session',
    tiktokTtTargetIdc: 'idc',
    senderUniqueId: null
};

interface Harness {
    url: string;
    calls: { resolveRoomId: number; sendComment: number; sentContent: string[] };
    hub: EchoHub;
    session: SessionStore;
}

async function withServer(
    overrides: Partial<ServerConfig>,
    depsOverrides: Partial<CommentSenderDeps>,
    run: (harness: Harness) => Promise<void>
): Promise<void> {
    const config: ServerConfig = { ...baseConfig, ...overrides };
    const calls = { resolveRoomId: 0, sendComment: 0, sentContent: [] as string[] };
    const hub = new EchoHub();

    const deps: CommentSenderDeps = {
        resolveRoomId: async () => {
            calls.resolveRoomId += 1;
            return 'room-1';
        },
        sendComment: async ({ content }) => {
            calls.sendComment += 1;
            calls.sentContent.push(content);
        },
        ...depsOverrides
    };

    const sender = createCommentSender(config, {
        publishEcho: (event) => hub.publish(event),
        ...deps
    });
    const session = createSessionStore({
        sessionId: config.tiktokSessionId,
        ttTargetIdc: config.tiktokTtTargetIdc
    });
    const server = createCommentServer({ config, sender, hub, session });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
        await run({ url: `http://127.0.0.1:${port}`, calls, hub, session });
    } finally {
        hub.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}

function post(url: string, body: string, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${url}/api/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body
    });
}

interface SseEvent {
    requestId: string;
    confirmed: boolean;
    appearedMs: number | null;
    echoReason: string | null;
}

async function openEchoStream(url: string, token: string): Promise<{ next(timeoutMs?: number): Promise<SseEvent>; close(): void }> {
    const controller = new AbortController();
    const response = await fetch(`${url}/api/comments/events`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal
    });
    assert.equal(response.status, 200);
    assert.equal(response.body !== null, true);

    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    const events: SseEvent[] = [];
    let buffer = '';
    let closed = false;

    void (async () => {
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) return;
                buffer += decoder.decode(value, { stream: true });

                let index = buffer.indexOf('\n\n');
                while (index >= 0) {
                    const block = buffer.slice(0, index);
                    buffer = buffer.slice(index + 2);
                    const data = block
                        .split('\n')
                        .filter((line) => line.startsWith('data: '))
                        .map((line) => line.slice(6))
                        .join('\n');
                    if (data !== '') events.push(JSON.parse(data) as SseEvent);
                    index = buffer.indexOf('\n\n');
                }
            }
        } catch {
            // aborted by close()
        } finally {
            closed = true;
        }
    })();

    return {
        async next(timeoutMs = 2_000): Promise<SseEvent> {
            const started = Date.now();
            while (true) {
                const event = events.shift();
                if (event !== undefined) return event;
                if (closed && events.length === 0) throw new Error('SSE stream closed');
                if (Date.now() - started > timeoutMs) throw new Error('SSE event timeout');
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
        },
        close: () => controller.abort()
    };
}

function createDeferredEcho(): { echo: EchoConfirmerLike; resolve: (result: EchoResult) => void } {
    let resolveEcho: (result: EchoResult) => void = () => {};
    const promise = new Promise<EchoResult>((resolve) => {
        resolveEcho = resolve;
    });

    return {
        echo: {
            warm: async () => true,
            expect: () => ({
                promise,
                markSent: () => {},
                cancel: () => {}
            })
        },
        resolve: resolveEcho
    };
}

describe('backend HTTP contract', () => {

    test('GET /health reports readiness without a token', async () => {
        await withServer({}, {}, async ({ url }) => {
            const response = await fetch(`${url}/health`);
            assert.equal(response.status, 200);
            assert.deepEqual(await response.json(), { ok: true, dryRun: false, echo: false });
        });
    });

    test('health accepts no token but rejects a wrong one', async () => {
        await withServer({}, {}, async ({ url }) => {
            const withValidToken = await fetch(`${url}/health`, {
                headers: { Authorization: `Bearer ${baseConfig.accessToken}` }
            });
            assert.equal(withValidToken.status, 200);

            const withWrongToken = await fetch(`${url}/health`, {
                headers: { Authorization: 'Bearer wrong-token' }
            });
            assert.equal(withWrongToken.status, 401);
            assert.equal((await withWrongToken.json()).code, 'unauthorized');
        });
    });

    test('rejects a missing or wrong bearer token', async () => {
        await withServer({}, {}, async ({ url }) => {
            const missing = await post(url, JSON.stringify({ uniqueId: 'someone', content: 'hi' }));
            assert.equal(missing.status, 401);
            assert.equal((await missing.json()).code, 'unauthorized');

            const wrong = await post(url, JSON.stringify({ uniqueId: 'someone', content: 'hi' }), {
                Authorization: 'Bearer nope'
            });
            assert.equal(wrong.status, 401);
        });
    });

    test('accepts a valid request and returns a request id', async () => {
        await withServer({}, {}, async ({ url, calls }) => {
            const response = await post(url, JSON.stringify({ uniqueId: '@someone', content: ' xin chào ' }), {
                Authorization: `Bearer ${baseConfig.accessToken}`
            });
            const body = await response.json();

            assert.equal(response.status, 200);
            assert.equal(body.ok, true);
            assert.match(body.requestId, /^[0-9a-f-]{36}$/);
            assert.equal(body.dryRun, false);
            assert.equal(typeof body.providerMs, 'number');
            assert.equal(typeof body.backendMs, 'number');
            assert.equal(body.confirmed, undefined);
            assert.equal(calls.sendComment, 1);
            assert.deepEqual(calls.sentContent, ['xin chào']);
        });
    });

    test('validates username and content before sending', async () => {
        await withServer({}, {}, async ({ url, calls }) => {
            const auth = { Authorization: `Bearer ${baseConfig.accessToken}` };

            const badName = await post(url, JSON.stringify({ uniqueId: 'not a name', content: 'hi' }), auth);
            assert.equal(badName.status, 400);
            assert.equal((await badName.json()).code, 'invalid_unique_id');

            const empty = await post(url, JSON.stringify({ uniqueId: 'someone', content: '   ' }), auth);
            assert.equal(empty.status, 400);
            assert.equal((await empty.json()).code, 'invalid_content');

            const long = await post(url, JSON.stringify({ uniqueId: 'someone', content: 'a'.repeat(151) }), auth);
            assert.equal(long.status, 400);
            assert.equal((await long.json()).code, 'invalid_content');

            assert.equal(calls.sendComment, 0);
        });
    });

    test('rejects malformed bodies and content types', async () => {
        await withServer({}, {}, async ({ url }) => {
            const auth = { Authorization: `Bearer ${baseConfig.accessToken}` };

            const invalidJson = await post(url, '{ oops', auth);
            assert.equal(invalidJson.status, 400);
            assert.equal((await invalidJson.json()).code, 'invalid_json');

            const wrongType = await fetch(`${url}/api/comments`, {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain', ...auth },
                body: 'hello'
            });
            assert.equal(wrongType.status, 415);

            const oversized = await post(url, JSON.stringify({ uniqueId: 'someone', content: 'a', pad: 'x'.repeat(9_000) }), auth);
            assert.equal(oversized.status, 413);
            assert.equal((await oversized.json()).code, 'body_too_large');
        });
    });

    test('enforces the send rate limit', async () => {
        await withServer({ sendIntervalMs: 5_000 }, {}, async ({ url }) => {
            const auth = { Authorization: `Bearer ${baseConfig.accessToken}` };
            const first = await post(url, JSON.stringify({ uniqueId: 'someone', content: 'one' }), auth);
            const second = await post(url, JSON.stringify({ uniqueId: 'someone', content: 'two' }), auth);

            assert.equal(first.status, 200);
            assert.equal(second.status, 429);
            assert.ok(Number(second.headers.get('retry-after')) >= 1);
            const body = await second.json();
            assert.equal(body.code, 'rate_limited');
            assert.ok(body.retryAfterMs > 0);
        });
    });

    test('maps provider failures without leaking internals', async () => {
        await withServer({}, {
            sendComment: async () => {
                throw new AppError(409, 'stream_unavailable', 'Kênh không còn LIVE nên không gửi được bình luận.');
            }
        }, async ({ url }) => {
            const response = await post(url, JSON.stringify({ uniqueId: 'someone', content: 'hi' }), {
                Authorization: `Bearer ${baseConfig.accessToken}`
            });
            const body = await response.json();
            assert.equal(response.status, 409);
            assert.equal(body.ok, false);
            assert.equal(body.code, 'stream_unavailable');
        });
    });

    test('serves only the documented routes and methods', async () => {
        await withServer({}, {}, async ({ url }) => {
            const notFound = await fetch(`${url}/nope`);
            assert.equal(notFound.status, 404);

            const wrongMethod = await fetch(`${url}/api/comments`);
            assert.equal(wrongMethod.status, 405);
            assert.equal(wrongMethod.headers.get('allow'), 'POST');

            const wrongHealth = await fetch(`${url}/health`, { method: 'POST' });
            assert.equal(wrongHealth.status, 405);

            const unauthenticatedStream = await fetch(`${url}/api/comments/events`);
            assert.equal(unauthenticatedStream.status, 401);

            const wrongSessionMethod = await fetch(`${url}/api/session`, { method: 'POST' });
            assert.equal(wrongSessionMethod.status, 405);
            assert.equal(wrongSessionMethod.headers.get('allow'), 'GET, PUT');

            const unauthenticatedSession = await fetch(`${url}/api/session`);
            assert.equal(unauthenticatedSession.status, 401);
        });
    });

    test('accepts a full LIVE URL and extracts the handle', async () => {
        const seen: string[] = [];
        await withServer({}, {
            resolveRoomId: async (uniqueId) => {
                seen.push(uniqueId);
                return 'room-1';
            }
        }, async ({ url }) => {
            const auth = { Authorization: `Bearer ${baseConfig.accessToken}` };

            const fromUrl = await post(url,
                JSON.stringify({ uniqueId: 'https://www.tiktok.com/@mtien0044/live', content: 'hi' }), auth);
            assert.equal(fromUrl.status, 200);
            assert.deepEqual(seen, ['mtien0044']);

            const fromAt = await post(url, JSON.stringify({ uniqueId: '@other_name', content: 'yo' }), auth);
            assert.equal(fromAt.status, 200);
            assert.deepEqual(seen, ['mtien0044', 'other_name']);

            const foreignUrl = await post(url, JSON.stringify({ uniqueId: 'https://example.com/@x', content: 'no' }), auth);
            assert.equal(foreignUrl.status, 400);
            assert.equal((await foreignUrl.json()).code, 'invalid_unique_id');
        });
    });

    test('stores a TikTok session at runtime without echoing it', async () => {
        await withServer({ tiktokSessionId: null, tiktokTtTargetIdc: null }, {}, async ({ url, session }) => {
            const auth = { Authorization: `Bearer ${baseConfig.accessToken}` };

            assert.equal(session.configured(), false);
            const before = await fetch(`${url}/api/session`, { headers: auth });
            assert.equal(before.status, 200);
            assert.deepEqual(await before.json(), { ok: true, configured: false });

            const unauthenticated = await fetch(`${url}/api/session`);
            assert.equal(unauthenticated.status, 401);

            const put = await fetch(`${url}/api/session`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', ...auth },
                body: JSON.stringify({ sessionId: 'secret-session-value', ttTargetIdc: 'useast1a' })
            });
            const putBody = await put.json();
            assert.equal(put.status, 200);
            assert.deepEqual(putBody, { ok: true, configured: true });
            assert.equal(JSON.stringify(putBody).includes('secret-session-value'), false);

            assert.equal(session.configured(), true);
            assert.deepEqual(session.get(), { sessionId: 'secret-session-value', ttTargetIdc: 'useast1a' });

            const after = await fetch(`${url}/api/session`, { headers: auth });
            assert.deepEqual(await after.json(), { ok: true, configured: true });
        });
    });

    test('rejects incomplete or malformed sessions without clearing the stored one', async () => {
        await withServer({}, {}, async ({ url, session }) => {
            const auth = { Authorization: `Bearer ${baseConfig.accessToken}` };
            const put = (body: unknown, contentType = 'application/json') =>
                fetch(`${url}/api/session`, {
                    method: 'PUT',
                    headers: { 'Content-Type': contentType, ...auth },
                    body: typeof body === 'string' ? body : JSON.stringify(body)
                });

            const missing = await put({ sessionId: 'only-one-field' });
            assert.equal(missing.status, 400);
            assert.equal((await missing.json()).code, 'invalid_session');

            const spaced = await put({ sessionId: 'has spaces', ttTargetIdc: 'x' });
            assert.equal(spaced.status, 400);

            const wrongType = await put('{ oops', 'text/plain');
            assert.equal(wrongType.status, 415);

            assert.deepEqual(session.get(), { sessionId: 'session', ttTargetIdc: 'idc' });
        });
    });

    test('dry run validates but never contacts TikTok or the provider', async () => {
        await withServer({ dryRun: true }, {}, async ({ url, calls }) => {
            const response = await post(url, JSON.stringify({ uniqueId: 'someone', content: 'hi' }), {
                Authorization: `Bearer ${baseConfig.accessToken}`
            });
            const body = await response.json();

            assert.equal(response.status, 200);
            assert.equal(body.dryRun, true);
            assert.match(body.requestId, /^dry-/);
            assert.equal(body.providerMs, null);
            assert.equal(calls.resolveRoomId, 0);
            assert.equal(calls.sendComment, 0);
        });
    });

    test('caches the room id between sends', async () => {
        await withServer({}, {}, async ({ url, calls }) => {
            const auth = { Authorization: `Bearer ${baseConfig.accessToken}` };
            await post(url, JSON.stringify({ uniqueId: 'someone', content: 'one' }), auth);
            await post(url, JSON.stringify({ uniqueId: 'someone', content: 'two' }), auth);

            assert.equal(calls.sendComment, 2);
            assert.equal(calls.resolveRoomId, 1);
        });
    });

});

describe('low-latency sending', () => {

    test('responds before the echo arrives and pushes it over SSE', async () => {
        const { echo, resolve } = createDeferredEcho();

        await withServer({ echoEnabled: true }, { echo }, async ({ url }) => {
            const stream = await openEchoStream(url, baseConfig.accessToken);

            try {
                const started = Date.now();
                const response = await post(url, JSON.stringify({ uniqueId: 'someone', content: 'nhanh' }), {
                    Authorization: `Bearer ${baseConfig.accessToken}`
                });
                const body = await response.json();
                const elapsed = Date.now() - started;

                assert.equal(response.status, 200);
                assert.equal(body.ok, true);
                assert.ok(elapsed < 300, `send response took ${elapsed}ms; it must not wait for echo`);

                resolve({ confirmed: true, appearedMs: 123, reason: null });

                const event = await stream.next();
                assert.equal(event.requestId, body.requestId);
                assert.equal(event.confirmed, true);
                assert.equal(event.appearedMs, 123);
                assert.equal(event.echoReason, null);
            } finally {
                stream.close();
            }
        });
    });

    test('publishes an unconfirmed echo result when confirmation is off', async () => {
        await withServer({ echoEnabled: false }, {}, async ({ url }) => {
            const stream = await openEchoStream(url, baseConfig.accessToken);

            try {
                const response = await post(url, JSON.stringify({ uniqueId: 'someone', content: 'hi' }), {
                    Authorization: `Bearer ${baseConfig.accessToken}`
                });
                const body = await response.json();
                const event = await stream.next();

                assert.equal(event.requestId, body.requestId);
                assert.equal(event.confirmed, false);
                assert.equal(event.echoReason, 'echo_disabled');
            } finally {
                stream.close();
            }
        });
    });

    test('prewarm resolves the room once and removes the lookup from the send path', async () => {
        await withServer({}, {}, async ({ url, calls }) => {
            const auth = { Authorization: `Bearer ${baseConfig.accessToken}` };
            const prewarm = await fetch(`${url}/api/rooms/prewarm`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...auth },
                body: JSON.stringify({ uniqueId: 'someone' })
            });

            assert.equal(prewarm.status, 200);
            assert.equal(calls.resolveRoomId, 1);

            const started = Date.now();
            await post(url, JSON.stringify({ uniqueId: 'someone', content: 'hi' }), auth);
            const elapsed = Date.now() - started;

            assert.equal(calls.resolveRoomId, 1);
            assert.ok(elapsed < 300, `send after prewarm took ${elapsed}ms`);
        });
    });

    test('prewarm reports whether the target channel is live', async () => {
        await withServer({}, { fetchIsLive: async () => true }, async ({ url }) => {
            const response = await fetch(`${url}/api/rooms/prewarm`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${baseConfig.accessToken}` },
                body: JSON.stringify({ uniqueId: 'someone' })
            });
            assert.equal(response.status, 200);
            assert.deepEqual(await response.json(), { ok: true, isLive: true });
        });
    });

    test('prewarm reports offline and survives a failed live check', async () => {
        await withServer({}, { fetchIsLive: async () => false }, async ({ url }) => {
            const response = await fetch(`${url}/api/rooms/prewarm`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${baseConfig.accessToken}` },
                body: JSON.stringify({ uniqueId: 'someone' })
            });
            assert.equal(response.status, 200);
            assert.deepEqual(await response.json(), { ok: true, isLive: false });
        });

        await withServer({}, {
            fetchIsLive: async () => {
                throw new AppError(502, 'room_lookup_failed', 'boom');
            }
        }, async ({ url }) => {
            const response = await fetch(`${url}/api/rooms/prewarm`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${baseConfig.accessToken}` },
                body: JSON.stringify({ uniqueId: 'someone' })
            });
            assert.equal(response.status, 200);
            assert.deepEqual(await response.json(), { ok: true, isLive: null });
        });
    });

    test('dry-run prewarm never contacts TikTok and reports isLive null', async () => {
        let liveChecks = 0;
        await withServer({ dryRun: true }, {
            fetchIsLive: async () => {
                liveChecks += 1;
                return true;
            }
        }, async ({ url }) => {
            const response = await fetch(`${url}/api/rooms/prewarm`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${baseConfig.accessToken}` },
                body: JSON.stringify({ uniqueId: 'https://www.tiktok.com/@someone/live' })
            });
            assert.equal(response.status, 200);
            assert.deepEqual(await response.json(), { ok: true, isLive: null });
            assert.equal(liveChecks, 0);
        });
    });

    test('serves a stale room id while refreshing it in the background', async () => {
        let lookups = 0;
        await withServer({ roomCacheTtlMs: 40 }, {
            resolveRoomId: async () => {
                lookups += 1;
                if (lookups > 1) await new Promise((resolve) => setTimeout(resolve, 200));
                return `room-${lookups}`;
            }
        }, async ({ url }) => {
            const auth = { Authorization: `Bearer ${baseConfig.accessToken}` };
            await fetch(`${url}/api/rooms/prewarm`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...auth },
                body: JSON.stringify({ uniqueId: 'someone' })
            });
            assert.equal(lookups, 1);

            await new Promise((resolve) => setTimeout(resolve, 60));

            const started = Date.now();
            const response = await post(url, JSON.stringify({ uniqueId: 'someone', content: 'hi' }), auth);
            const elapsed = Date.now() - started;

            assert.equal(response.status, 200);
            assert.ok(elapsed < 150, `stale send took ${elapsed}ms; it must not wait for the refresh`);
            assert.equal(lookups, 2);
        });
    });

});

describe('configuration', () => {

    const minimalEnv = {
        APP_TOKEN: 'test-token-0123456789',
        SEND_DRY_RUN: '1'
    };

    test('accepts a dry-run configuration without provider credentials', () => {
        const config = loadConfig(minimalEnv);
        assert.equal(config.dryRun, true);
        assert.equal(config.echoEnabled, false);
        assert.equal(config.port, 3001);
    });

    test('refuses to start without an access token', () => {
        assert.throws(() => loadConfig({ SEND_DRY_RUN: '1' }), /APP_TOKEN/);
        assert.throws(() => loadConfig({ APP_TOKEN: 'short', SEND_DRY_RUN: '1' }), /ít nhất 16/);
    });

    test('starts real mode without any Euler key by sending straight to webcast', () => {
        const config = loadConfig({ APP_TOKEN: 'test-token-0123456789' });
        assert.equal(config.dryRun, false);
        assert.equal(config.sendProvider, 'webcast');
        assert.equal(config.eulerApiKey, null);
        assert.equal(config.tiktokSessionId, null);
        assert.equal(config.tiktokTtTargetIdc, null);
    });

    test('accepts an explicit Euler send provider only with its key', () => {
        const config = loadConfig({
            APP_TOKEN: 'test-token-0123456789',
            SEND_PROVIDER: 'euler',
            EULER_API_KEY: 'euler-key'
        });
        assert.equal(config.sendProvider, 'euler');

        assert.throws(
            () => loadConfig({ APP_TOKEN: 'test-token-0123456789', SEND_PROVIDER: 'euler' }),
            /EULER_API_KEY/
        );
    });

    test('rejects an unknown send provider', () => {
        assert.throws(
            () => loadConfig({ APP_TOKEN: 'test-token-0123456789', SEND_PROVIDER: 'cloud' }),
            /SEND_PROVIDER/
        );
    });

    test('rejects a half-configured session pair', () => {
        assert.throws(
            () => loadConfig({
                APP_TOKEN: 'test-token-0123456789',
                EULER_API_KEY: 'euler-key',
                TIKTOK_SESSION_ID: 'session'
            }),
            /TIKTOK_SESSION_ID[\s\S]*TIKTOK_TT_TARGET_IDC/
        );
    });

    test('rejects out-of-range numbers', () => {
        assert.throws(
            () => loadConfig({ ...minimalEnv, PORT: '70000' }),
            /PORT/
        );
    });

});
