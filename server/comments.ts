import { randomUUID } from 'node:crypto';
import { AppError } from './errors';
import { MAX_CONTENT_LENGTH, type ServerConfig } from './config';
import { RateLimiter } from './rate-limit';
import type { EchoExpectation, EchoResult } from './echo';
import type { EchoEvent } from './events';

export interface CommentSendInput {
    uniqueId?: unknown;
    content?: unknown;
}

/**
 * The slice of {@link EchoConfirmer} the send pipeline needs. Structural typing
 * keeps the pipeline testable without opening a real room connection.
 */
export interface EchoConfirmerLike {
    warm(uniqueId: string, timeoutMs: number): Promise<boolean>;
    expect(uniqueId: string, content: string, timeoutMs: number): EchoExpectation;
}

export interface CommentSenderDeps {
    resolveRoomId(uniqueId: string): Promise<string>;
    fetchIsLive?(uniqueId: string): Promise<boolean>;
    sendComment(params: { uniqueId: string; content: string; roomId: string }): Promise<void>;
    /** Optional: opens the browser provider's window early. Never blocks prewarm. */
    prewarmBrowser?(uniqueId: string): Promise<void>;
    echo?: EchoConfirmerLike;
    publishEcho?: (event: EchoEvent) => void;
    now?: () => number;
}

export interface CommentResult {
    requestId: string;
    dryRun: boolean;
    /** Server-measured time from send start to provider acceptance. */
    providerMs: number | null;
}

export interface CommentSender {
    sendComment(input: CommentSendInput): Promise<CommentResult>;
    prewarm(uniqueId: unknown): Promise<PrewarmResult>;
}

export interface PrewarmResult {
    /** Whether the target channel is live; null when unknown (dry-run or lookup failure). */
    isLive: boolean | null;
}

const UNIQUE_ID_PATTERN = /^[A-Za-z0-9_.]{1,24}$/;
const LIVE_URL_PATTERN = /^(?:https?:\/\/)?(?:www\.|m\.)?tiktok\.com\/@([A-Za-z0-9_.]{1,24})(?:[/?#]|$)/i;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function normalizeUniqueId(value: unknown): string {
    if (typeof value !== 'string') {
        throw new AppError(400, 'invalid_unique_id', 'Thiếu username TikTok.');
    }
    let raw = value.trim();
    const urlMatch = LIVE_URL_PATTERN.exec(raw);
    if (urlMatch !== null) raw = urlMatch[1];
    const uniqueId = raw.replace(/^@/, '');
    if (!UNIQUE_ID_PATTERN.test(uniqueId)) {
        throw new AppError(400, 'invalid_unique_id',
            'Nhập username (chữ, số, dấu chấm, gạch dưới, tối đa 24 ký tự) '
            + 'hoặc dán link LIVE dạng https://www.tiktok.com/@username/live.');
    }
    return uniqueId;
}

function normalizeContent(value: unknown): string {
    if (typeof value !== 'string') {
        throw new AppError(400, 'invalid_content', 'Thiếu nội dung bình luận.');
    }
    if (CONTROL_CHARACTERS.test(value)) {
        throw new AppError(400, 'invalid_content', 'Nội dung chứa ký tự điều khiển không hợp lệ.');
    }
    const content = value.trim();
    if (content === '') {
        throw new AppError(400, 'invalid_content', 'Nhập nội dung bình luận.');
    }
    if ([...content].length > MAX_CONTENT_LENGTH) {
        throw new AppError(400, 'invalid_content',
            `Nội dung tối đa ${MAX_CONTENT_LENGTH} ký tự.`);
    }
    return content;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new AppError(504, 'provider_timeout', message));
        }, ms);
        timer.unref?.();

        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            }
        );
    });
}

interface RoomEntry {
    roomId: string;
    expiresAt: number;
    refreshing: Promise<void> | null;
}

export function createCommentSender(config: ServerConfig, deps: CommentSenderDeps): CommentSender {

    const now = deps.now ?? Date.now;
    const limiter = new RateLimiter(config.sendIntervalMs, config.sendMaxPerMinute, now);
    const rooms = new Map<string, RoomEntry>();
    const lookups = new Map<string, Promise<string>>();

    const lookupRoom = (uniqueId: string): Promise<string> => {
        const existing = lookups.get(uniqueId);
        if (existing !== undefined) return existing;

        const promise = withTimeout(
            deps.resolveRoomId(uniqueId),
            config.providerTimeoutMs,
            'Dịch vụ TikTok/Euler không phản hồi kịp khi tìm phòng.'
        ).finally(() => {
            lookups.delete(uniqueId);
        });

        lookups.set(uniqueId, promise);
        return promise;
    };

    const storeRoom = (uniqueId: string, roomId: string): void => {
        if (config.roomCacheTtlMs <= 0) return;
        rooms.set(uniqueId, {
            roomId,
            expiresAt: now() + config.roomCacheTtlMs,
            refreshing: null
        });
    };

    const refreshRoom = (uniqueId: string, entry: RoomEntry): void => {
        if (entry.refreshing !== null) return;

        entry.refreshing = lookupRoom(uniqueId)
            .then((roomId) => {
                const current = rooms.get(uniqueId);
                if (current !== undefined && current === entry) {
                    current.roomId = roomId;
                    current.expiresAt = now() + config.roomCacheTtlMs;
                } else {
                    storeRoom(uniqueId, roomId);
                }
            })
            .catch(() => {
                // Keep the stale room ID; the send itself will report a real failure.
            })
            .finally(() => {
                if (rooms.get(uniqueId) === entry) entry.refreshing = null;
            });
    };

    /**
     * Return a room ID without waiting for a refresh: a cached ID is served even
     * after its TTL while the next lookup runs in the background.
     */
    const getRoomId = async (uniqueId: string): Promise<string> => {
        const entry = rooms.get(uniqueId);
        if (entry !== undefined) {
            if (entry.expiresAt <= now()) refreshRoom(uniqueId, entry);
            return entry.roomId;
        }

        const roomId = await lookupRoom(uniqueId);
        storeRoom(uniqueId, roomId);
        return roomId;
    };

    const warmEcho = async (uniqueId: string): Promise<boolean> => {
        if (!config.echoEnabled || deps.echo === undefined) return false;
        return deps.echo.warm(uniqueId, Math.min(5_000, config.echoTimeoutMs));
    };

    return {
        async prewarm(rawUniqueId: unknown): Promise<PrewarmResult> {
            const uniqueId = normalizeUniqueId(rawUniqueId);
            if (config.dryRun) return { isLive: null };

            // Not awaited: launching Chrome must not slow the live check the app
            // waits on, and a warm-up that fails is harmless because the send
            // repeats the same navigation itself.
            if (deps.prewarmBrowser !== undefined) {
                void deps.prewarmBrowser(uniqueId).catch(() => undefined);
            }

            const liveCheck = deps.fetchIsLive !== undefined
                ? withTimeout(
                    deps.fetchIsLive(uniqueId),
                    config.providerTimeoutMs,
                    'Dịch vụ TikTok/Euler không phản hồi kịp khi kiểm tra LIVE.'
                )
                : Promise.resolve(null);

            const results = await Promise.allSettled([
                getRoomId(uniqueId),
                warmEcho(uniqueId),
                liveCheck
            ]);
            const live = results[2];
            return { isLive: live.status === 'fulfilled' ? live.value : null };
        },

        async sendComment(input: CommentSendInput): Promise<CommentResult> {
            const uniqueId = normalizeUniqueId(input?.uniqueId);
            const content = normalizeContent(input?.content);

            const verdict = limiter.take();
            if (!verdict.ok) {
                const waitSeconds = Math.max(1, Math.ceil(verdict.retryAfterMs / 1000));
                throw new AppError(429, 'rate_limited',
                    `Gửi quá nhanh. Thử lại sau ${waitSeconds} giây.`,
                    { details: { retryAfterMs: verdict.retryAfterMs } });
            }

            if (config.dryRun) {
                return {
                    requestId: `dry-${randomUUID()}`,
                    dryRun: true,
                    providerMs: null
                };
            }

            const requestId = randomUUID();
            const roomId = await getRoomId(uniqueId);

            // Arm the echo match before the send so a fast echo is not missed.
            // Never await the connection here: the send must not wait for it.
            const expectation = config.echoEnabled && deps.echo !== undefined
                ? deps.echo.expect(uniqueId, content, config.echoTimeoutMs)
                : null;

            const sentAt = now();
            expectation?.markSent(sentAt);

            try {
                await withTimeout(
                    deps.sendComment({ uniqueId, content, roomId }),
                    config.providerTimeoutMs,
                    'Dịch vụ gửi không phản hồi kịp; bình luận có thể đã được gửi.'
                );
            } catch (error) {
                expectation?.cancel('send_failed');
                throw error;
            }

            const providerMs = Math.max(0, now() - sentAt);
            const publishEcho = deps.publishEcho;

            if (publishEcho !== undefined) {
                if (expectation !== null) {
                    void expectation.promise.then((echo: EchoResult) => {
                        // Let the HTTP response flush before the SSE event.
                        setImmediate(() => publishEcho({
                            requestId,
                            uniqueId,
                            confirmed: echo.confirmed,
                            appearedMs: echo.appearedMs,
                            echoReason: echo.reason
                        }));
                    });
                } else {
                    setImmediate(() => publishEcho({
                        requestId,
                        uniqueId,
                        confirmed: false,
                        appearedMs: null,
                        echoReason: config.echoEnabled ? 'echo_unavailable' : 'echo_disabled'
                    }));
                }
            }

            return { requestId, dryRun: false, providerMs };
        }
    };
}
