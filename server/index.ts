import { loadConfig, type ServerConfig } from './config';
import { createCommentSender } from './comments';
import { createLiveAdapters } from './live';
import { EchoConfirmer } from './echo';
import { EchoHub } from './events';
import { createCommentServer } from './http';
import { createSessionStore } from './session';

function main(): void {
    let config: ServerConfig;
    try {
        config = loadConfig(process.env);
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        console.error('Sao chép server/.env.example thành server/.env rồi điền giá trị.');
        process.exitCode = 1;
        return;
    }

    const session = createSessionStore({
        sessionId: config.tiktokSessionId,
        ttTargetIdc: config.tiktokTtTargetIdc
    });
    const adapters = createLiveAdapters(config, session);

    const echo = config.echoEnabled
        ? new EchoConfirmer({
            createConnection: adapters.createEchoConnection,
            idleMs: config.echoIdleMs,
            senderUniqueId: config.senderUniqueId,
            log: (message) => console.warn(message)
        })
        : undefined;

    const hub = new EchoHub();
    const sender = createCommentSender(config, {
        resolveRoomId: adapters.resolveRoomId,
        fetchIsLive: (uniqueId) => adapters.fetchIsLive(uniqueId),
        sendComment: (params) => adapters.sendComment(params),
        echo,
        publishEcho: (event) => hub.publish(event)
    });

    const server = createCommentServer({
        config,
        sender,
        hub,
        session,
        log: (line) => console.log(line)
    });

    server.on('error', (error) => {
        console.error(`Không mở được cổng ${config.host}:${config.port}: ${error.message}`);
        process.exitCode = 1;
    });

    server.listen(config.port, config.host, () => {
        console.log(`Backend gửi bình luận đang chạy tại http://${config.host}:${config.port}`);
        console.log(`- GET  /health`);
        console.log(`- POST /api/comments (Bearer token)`);
        console.log(`- POST /api/rooms/prewarm (Bearer token)`);
        console.log(`- GET  /api/comments/events (SSE, Bearer token)`);
        console.log('- GET/PUT /api/session (Bearer token, phiên TikTok giữ trong RAM)');
        if (config.dryRun) {
            console.log('CHẾ ĐỘ THỬ: SEND_DRY_RUN=1, không gửi gì lên TikTok.');
        }
        if (!config.dryRun) {
            console.log(`Xác nhận bình luận trên LIVE: ${config.echoEnabled ? 'bật' : 'tắt'} (tối đa ${config.echoTimeoutMs} ms).`);
        }
        console.log('Chỉ dùng cho một người vận hành; không công khai cổng này trực tiếp ra Internet.');
    });

    const shutdown = (signal: string): void => {
        console.log(`Nhận ${signal}, đang dừng…`);
        server.close(() => {
            hub.close();
            void echo?.close().finally(() => process.exit(0));
        });
        setTimeout(() => process.exit(0), 5_000).unref();
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
