import http from 'node:http';
import https from 'node:https';
// Import the package entry point, not src/lib/client: the library has circular
// imports, and starting at the client module leaves the legacy export in a TDZ.
import { EulerSigner, TikTokLiveConnection } from '../src/index';
import { ControlEvent, WebcastEvent } from '../src/types/events';
import { AppError } from './errors';
import type { EchoChatData, EchoConnection } from './echo';
import type { ServerConfig } from './config';
import type { SessionStore } from './session';

export interface LiveAdapters {
    resolveRoomId(uniqueId: string): Promise<string>;
    fetchIsLive(uniqueId: string): Promise<boolean>;
    sendComment(params: { uniqueId: string; content: string; roomId: string }): Promise<void>;
    createEchoConnection(uniqueId: string): EchoConnection;
}

const MAX_CACHED_CONNECTIONS = 10;

function errorName(error: unknown): string {
    return error instanceof Error ? error.name : '';
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function mapLookupError(error: unknown): AppError {
    if (error instanceof AppError) return error;

    const name = errorName(error);
    const message = errorMessage(error);

    if (name === 'PremiumFeatureError') {
        return new AppError(502, 'provider_plan_required',
            'Dịch vụ tìm phòng yêu cầu gói API trả phí.', { cause: error });
    }
    if (name === 'FetchIsLiveError' || /offline|room id/i.test(message)) {
        return new AppError(409, 'stream_unavailable',
            'Không tìm thấy phòng LIVE cho username này; kênh có thể đang offline.', { cause: error });
    }
    if (/timeout|ECONNABORTED|ETIMEDOUT/i.test(message)) {
        return new AppError(504, 'provider_timeout',
            'Dịch vụ TikTok/Euler không phản hồi kịp khi tìm phòng.', { cause: error });
    }
    return new AppError(502, 'room_lookup_failed',
        'Không tìm được phòng LIVE từ TikTok/Euler.', { cause: error });
}

function mapSendError(error: unknown): AppError {
    if (error instanceof AppError) return error;

    const name = errorName(error);
    const message = errorMessage(error);

    if (name === 'PremiumFeatureError') {
        return new AppError(502, 'provider_plan_required',
            'Dịch vụ gửi chưa được cấp quyền hoặc gói API đã hết hạn.', { cause: error });
    }
    if (name === 'UserOfflineError') {
        return new AppError(409, 'stream_unavailable',
            'Kênh không còn LIVE nên không gửi được bình luận.', { cause: error });
    }
    if (/session/i.test(message)) {
        return new AppError(502, 'session_rejected',
            'TikTok từ chối session của tài khoản gửi; kiểm tra lại cookie sessionid và tt-target-idc.', { cause: error });
    }
    if (/timeout|ECONNABORTED|ETIMEDOUT/i.test(message)) {
        return new AppError(504, 'provider_timeout',
            'Dịch vụ gửi không phản hồi kịp; bình luận có thể đã được gửi.', { cause: error });
    }
    return new AppError(502, 'provider_error',
        'Dịch vụ gửi bình luận trả về lỗi. Thử lại sau.', { cause: error });
}

/**
 * Real adapters. Credentials are read from the server config only; the desktop
 * client never sees them. Sockets are kept alive and one connector is reused per
 * username so a send does not pay for TCP/TLS setup every time.
 */
export function createLiveAdapters(config: ServerConfig, session: SessionStore): LiveAdapters {

    const httpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 30_000, maxSockets: 4 });
    const httpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 30_000, maxSockets: 4 });

    const signer = new EulerSigner({
        apiKey: config.eulerApiKey ?? undefined,
        baseOptions: {
            httpAgent,
            httpsAgent,
            timeout: config.providerTimeoutMs
        }
    });

    const connections = new Map<string, TikTokLiveConnection>();

    const createConnection = (uniqueId: string): TikTokLiveConnection => {
        const current = session.get();
        return new TikTokLiveConnection(
            uniqueId,
            {
                fetchRoomInfoOnConnect: false,
                processInitialData: false,
                enableRequestPolling: false,
                sessionId: current?.sessionId ?? null,
                ttTargetIdc: current?.ttTargetIdc ?? null,
                signApiKey: config.eulerApiKey,
                webClientOptions: {
                    httpAgent,
                    httpsAgent,
                    timeout: config.providerTimeoutMs
                }
            },
            signer
        );
    };

    const getConnection = (uniqueId: string): TikTokLiveConnection => {
        const cached = connections.get(uniqueId);
        if (cached !== undefined) {
            // Refresh insertion order so the LRU eviction removes the coldest entry.
            connections.delete(uniqueId);
            connections.set(uniqueId, cached);
            return cached;
        }

        const connection = createConnection(uniqueId);
        connections.set(uniqueId, connection);

        if (connections.size > MAX_CACHED_CONNECTIONS) {
            const oldest = connections.keys().next().value;
            if (oldest !== undefined) connections.delete(oldest);
        }

        return connection;
    };

    return {
        async resolveRoomId(uniqueId: string): Promise<string> {
            const connection = getConnection(uniqueId);
            try {
                const roomId = await connection.fetchRoomId(uniqueId);
                if (typeof roomId !== 'string' || roomId === '') {
                    throw new AppError(409, 'stream_unavailable',
                        'Không lấy được room ID; kênh có thể đang offline.');
                }
                return roomId;
            } catch (error) {
                throw mapLookupError(error);
            }
        },

        async fetchIsLive(uniqueId: string): Promise<boolean> {
            const connection = getConnection(uniqueId);
            try {
                return await connection.fetchIsLive();
            } catch (error) {
                throw mapLookupError(error);
            }
        },

        async sendComment({ uniqueId, content, roomId }): Promise<void> {
            const connection = getConnection(uniqueId);
            try {
                const current = session.get();
                if (current === null) {
                    throw new AppError(409, 'session_missing',
                        'Chưa có phiên TikTok để gửi; kết nối tài khoản trước khi gửi bình luận.');
                }
                // Re-apply on every send: the login window can replace the
                // session while connections stay cached.
                connection.webClient.cookieJar.setSession(current.sessionId, current.ttTargetIdc);
                await connection.sendMessage(content, { roomId });
            } catch (error) {
                throw mapSendError(error);
            }
        },

        createEchoConnection(uniqueId: string): EchoConnection {
            const connection = new TikTokLiveConnection(
                uniqueId,
                {
                    fetchRoomInfoOnConnect: false,
                    processInitialData: false,
                    enableRequestPolling: false,
                    signApiKey: config.eulerApiKey,
                    webClientOptions: {
                        httpAgent,
                        httpsAgent,
                        timeout: config.providerTimeoutMs
                    }
                },
                signer
            );

            return {
                onChat(handler) {
                    connection.on(WebcastEvent.CHAT, (data) => handler(data as unknown as EchoChatData));
                },
                onClosed(handler) {
                    connection.on(ControlEvent.DISCONNECTED, handler);
                    connection.on(WebcastEvent.STREAM_END, handler);
                },
                connect: () => connection.connect(),
                disconnect: () => connection.disconnect()
            };
        }
    };
}
