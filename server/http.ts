import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { AppError } from './errors';
import type { ServerConfig } from './config';
import type { CommentSender } from './comments';
import type { EchoHub } from './events';
import type { SessionStore, TikTokSession } from './session';

export interface CommentServerContext {
    config: ServerConfig;
    sender: CommentSender;
    hub: EchoHub;
    session: SessionStore;
    setBrowserSendDelay?(delayMs: number): Promise<void>;
    log?: (line: string) => void;
}

export const MAX_BODY_BYTES = 8 * 1024;

function sendJson(
    res: http.ServerResponse,
    status: number,
    payload: Record<string, unknown>,
    options: { includeBody?: boolean; headers?: Record<string, string> } = {}
): void {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': String(Buffer.byteLength(body)),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...options.headers
    });
    res.end(options.includeBody === false ? undefined : body);
}

function isAuthorized(header: string | undefined, expectedToken: string): boolean {
    if (typeof header !== 'string') return false;
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match === null) return false;

    // Hash first so the comparison is constant time regardless of length.
    const actual = createHash('sha256').update(match[1]).digest();
    const expected = createHash('sha256').update(expectedToken).digest();
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;

    for await (const chunk of req) {
        const buffer = chunk as Buffer;
        size += buffer.length;
        if (size > MAX_BODY_BYTES) {
            tooLarge = true;
            continue;
        }
        chunks.push(buffer);
    }

    if (tooLarge) {
        throw new AppError(413, 'body_too_large', 'Dữ liệu gửi lên quá lớn.');
    }

    const text = Buffer.concat(chunks).toString('utf8');
    if (text.trim() === '') {
        throw new AppError(400, 'invalid_body', 'Thiếu dữ liệu JSON.');
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new AppError(400, 'invalid_json', 'Dữ liệu JSON không hợp lệ.');
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new AppError(400, 'invalid_body', 'Dữ liệu phải là một object JSON.');
    }

    return parsed as Record<string, unknown>;
}

function assertJsonContentType(req: http.IncomingMessage): void {
    const contentType = req.headers['content-type'] ?? '';
    if (!/^application\/json\b/i.test(contentType)) {
        throw new AppError(415, 'unsupported_media_type', 'Content-Type phải là application/json.');
    }
}

/** Log only provider error metadata; never log the comment, cookies, or request body. */
function summarizeProviderFailure(cause: unknown): string {
    const parts: string[] = [];
    if (cause instanceof Error) parts.push(`cause=${cause.name}`);

    if (typeof cause === 'object' && cause !== null) {
        const record = cause as Record<string, unknown>;
        if (typeof record.code === 'string' && /^[A-Za-z0-9_-]{1,48}$/.test(record.code)) {
            parts.push(`providerCode=${record.code}`);
        }
        if (typeof record.response === 'object' && record.response !== null) {
            const response = record.response as Record<string, unknown>;
            if (typeof response.status === 'number' && Number.isInteger(response.status)) {
                parts.push(`httpStatus=${response.status}`);
            }
        }
    }

    if (cause instanceof Error) {
        const status = /\b(?:status|HTTP)\s+(\d{3,6})\b/i.exec(cause.message)?.[1];
        if (status !== undefined) parts.push(`upstreamStatus=${status}`);
    }

    return parts.length > 0 ? parts.join(' ') : 'cause=unknown';
}

/** Validate the login pair from the desktop app. Secrets are never echoed back or logged. */
function readSessionBody(body: Record<string, unknown>): TikTokSession {
    const readField = (name: string, maxLength: number): string => {
        const value = body[name];
        if (typeof value !== 'string') {
            throw new AppError(400, 'invalid_session',
                'Thiếu sessionId và ttTargetIdc của tài khoản TikTok.');
        }
        const trimmed = value.trim();
        if (trimmed === '' || trimmed.length > maxLength || /[\s\u0000-\u001F\u007F]/.test(trimmed)) {
            throw new AppError(400, 'invalid_session', `Giá trị ${name} không hợp lệ.`);
        }
        return trimmed;
    };

    return {
        sessionId: readField('sessionId', 1024),
        ttTargetIdc: readField('ttTargetIdc', 64)
    };
}

export function createCommentServer(context: CommentServerContext): http.Server {
    const log = context.log ?? (() => {});

    const server = http.createServer((req, res) => {
        const startedAt = performance.now();
        let status = 500;
        let code = 'internal_error';
        let uniqueId: string | undefined;
        let requestId: string | undefined;

        const finish = (): void => {
            const elapsed = Math.round(performance.now() - startedAt);
            const parts = [
                `[comments] ${req.method ?? '?'} ${req.url ?? '/'} → ${status} ${code} ${elapsed}ms`
            ];
            if (uniqueId !== undefined) parts.push(`uniqueId=${uniqueId}`);
            if (requestId !== undefined) parts.push(`requestId=${requestId}`);
            log(parts.join(' '));
        };

        const handle = async (): Promise<void> => {
            const url = new URL(req.url ?? '/', 'http://localhost');

            if (url.pathname === '/health') {
                if (req.method !== 'GET' && req.method !== 'HEAD') {
                    throw new AppError(405, 'method_not_allowed', 'Chỉ hỗ trợ GET /health.', {
                        details: { allow: 'GET, HEAD' }
                    });
                }

                // Liveness probes may omit the token; a token that is present must be valid,
                // otherwise the desktop's "Kiểm tra" button cannot catch a wrong token.
                const authHeader = req.headers.authorization;
                if (authHeader !== undefined && !isAuthorized(authHeader, context.config.accessToken)) {
                    throw new AppError(401, 'unauthorized', 'Token truy cập không hợp lệ.');
                }

                status = 200;
                code = 'ok';
                sendJson(res, 200, {
                    ok: true,
                    dryRun: context.config.dryRun,
                    echo: context.config.echoEnabled
                }, { includeBody: req.method !== 'HEAD' });
                return;
            }

            if (url.pathname === '/api/comments') {
                if (req.method !== 'POST') {
                    throw new AppError(405, 'method_not_allowed', 'Chỉ hỗ trợ POST /api/comments.', {
                        details: { allow: 'POST' }
                    });
                }
                if (!isAuthorized(req.headers.authorization, context.config.accessToken)) {
                    throw new AppError(401, 'unauthorized', 'Token truy cập không hợp lệ.');
                }
                assertJsonContentType(req);

                const body = await readJsonBody(req);
                if (typeof body.uniqueId === 'string') uniqueId = body.uniqueId.trim().replace(/^@/, '');

                const backendStartedAt = Date.now();
                const result = await context.sender.sendComment(body);
                const backendMs = Date.now() - backendStartedAt;
                status = 200;
                code = 'ok';
                requestId = result.requestId;
                sendJson(res, 200, {
                    ok: true,
                    requestId: result.requestId,
                    dryRun: result.dryRun,
                    providerMs: result.providerMs,
                    // Server-side time for the whole send handler (rate limit,
                    // room lookup, provider call), so a client can subtract it
                    // from its own request time to see the network round trip.
                    backendMs
                });
                return;
            }

            if (url.pathname === '/api/settings/send-delay') {
                if (req.method !== 'POST') {
                    throw new AppError(405, 'method_not_allowed', 'Chỉ hỗ trợ POST /api/settings/send-delay.', {
                        details: { allow: 'POST' }
                    });
                }
                if (!isAuthorized(req.headers.authorization, context.config.accessToken)) {
                    throw new AppError(401, 'unauthorized', 'Token truy cập không hợp lệ.');
                }
                assertJsonContentType(req);

                const body = await readJsonBody(req);
                const delayMs = body.delayMs;
                if (typeof delayMs !== 'number' || ![2_000, 3_000, 5_000].includes(delayMs)) {
                    throw new AppError(400, 'invalid_send_delay', 'Độ trễ phải là 2, 3 hoặc 5 giây.');
                }
                if (context.setBrowserSendDelay === undefined) {
                    throw new AppError(503, 'browser_delay_unavailable',
                        'Điều khiển độ trễ cửa sổ TikTok không khả dụng với provider hiện tại.');
                }
                await context.setBrowserSendDelay(delayMs);
                status = 200;
                code = 'send_delay_updated';
                sendJson(res, 200, { ok: true, delayMs });
                return;
            }

            if (url.pathname === '/api/rooms/prewarm') {
                if (req.method !== 'POST') {
                    throw new AppError(405, 'method_not_allowed', 'Chỉ hỗ trợ POST /api/rooms/prewarm.', {
                        details: { allow: 'POST' }
                    });
                }
                if (!isAuthorized(req.headers.authorization, context.config.accessToken)) {
                    throw new AppError(401, 'unauthorized', 'Token truy cập không hợp lệ.');
                }
                assertJsonContentType(req);

                const body = await readJsonBody(req);
                if (typeof body.uniqueId === 'string') uniqueId = body.uniqueId.trim().replace(/^@/, '');

                const prewarm = await context.sender.prewarm(body.uniqueId);
                status = 200;
                code = 'prewarmed';
                sendJson(res, 200, { ok: true, isLive: prewarm.isLive });
                return;
            }

            if (url.pathname === '/api/session') {
                if (req.method !== 'GET' && req.method !== 'PUT') {
                    throw new AppError(405, 'method_not_allowed', 'Chỉ hỗ trợ GET và PUT /api/session.', {
                        details: { allow: 'GET, PUT' }
                    });
                }
                if (!isAuthorized(req.headers.authorization, context.config.accessToken)) {
                    throw new AppError(401, 'unauthorized', 'Token truy cập không hợp lệ.');
                }

                if (req.method === 'GET') {
                    status = 200;
                    code = 'session_status';
                    sendJson(res, 200, { ok: true, configured: context.session.configured() });
                    return;
                }

                assertJsonContentType(req);
                const sessionBody = await readJsonBody(req);
                context.session.set(readSessionBody(sessionBody));
                status = 200;
                code = 'session_updated';
                sendJson(res, 200, { ok: true, configured: true });
                return;
            }

            if (url.pathname === '/api/comments/events') {
                if (req.method !== 'GET') {
                    throw new AppError(405, 'method_not_allowed', 'Chỉ hỗ trợ GET /api/comments/events.', {
                        details: { allow: 'GET' }
                    });
                }
                if (!isAuthorized(req.headers.authorization, context.config.accessToken)) {
                    throw new AppError(401, 'unauthorized', 'Token truy cập không hợp lệ.');
                }

                res.writeHead(200, {
                    'Content-Type': 'text/event-stream; charset=utf-8',
                    'Cache-Control': 'no-store, no-transform',
                    Connection: 'keep-alive',
                    'X-Accel-Buffering': 'no'
                });
                res.write(': connected\n\n');
                context.hub.subscribe(res);

                status = 200;
                code = 'stream';
                return;
            }

            throw new AppError(404, 'not_found', 'Không có route này.');
        };

        handle()
            .catch((error: unknown) => {
                if (res.headersSent) {
                    res.end();
                    return;
                }

                if (error instanceof AppError) {
                    status = error.status;
                    code = error.code;
                    if (req.method === 'POST' && req.url?.split('?')[0] === '/api/comments'
                        && error.status >= 500 && error.cause !== undefined) {
                        log(`[comments] provider diagnostic ${summarizeProviderFailure(error.cause)}`);
                    }
                    const headers: Record<string, string> = {};
                    const retryAfterMs = error.details.retryAfterMs;
                    if (typeof retryAfterMs === 'number') {
                        headers['Retry-After'] = String(Math.max(1, Math.ceil(retryAfterMs / 1000)));
                    }
                    const allow = error.details.allow;
                    if (typeof allow === 'string') headers.Allow = allow;

                    sendJson(res, error.status, {
                        ok: false,
                        code: error.code,
                        error: error.message,
                        ...error.details
                    }, { headers });
                    return;
                }

                status = 500;
                code = 'internal_error';
                log(`[comments] lỗi nội bộ: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
                sendJson(res, 500, {
                    ok: false,
                    code: 'internal_error',
                    error: 'Lỗi máy chủ.'
                });
            })
            .finally(finish);
    });

    server.headersTimeout = 10_000;
    server.requestTimeout = 30_000;

    return server;
}
