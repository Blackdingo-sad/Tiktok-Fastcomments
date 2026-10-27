import { TikTokLiveConnection } from './src/index';
import { ControlEvent, WebcastEvent } from './src/types/events';

// From https://www.tiktok.com/@mtien0044/live -> handle only, no URL.
const uniqueId = 'mtien0044';
const WATCH_MS = 45_000;

async function main(): Promise<void> {
    const t0 = performance.now();
    const ms = (): string => `${(performance.now() - t0).toFixed(0)}ms`;

    // Same connection options the backend's live adapters use (no credentials:
    // reading chat does not need session cookies).
    const connection = new TikTokLiveConnection(uniqueId, {
        fetchRoomInfoOnConnect: false,
        processInitialData: false,
        enableRequestPolling: false
    });

    connection.on(ControlEvent.ERROR, (error: unknown) => {
        let detail: string;
        if (error instanceof Error) {
            detail = `${error.name}: ${error.message}`;
        } else if (typeof error === 'object' && error !== null) {
            const entries = Object.entries(error as Record<string, unknown>)
                .slice(0, 6)
                .map(([key, value]) => `${key}=${typeof value === 'object' ? '[obj]' : String(value)}`);
            detail = `object { ${entries.join(', ')} }`;
        } else {
            detail = String(error);
        }
        console.log(`[${ms()}] error event: ${detail}`);
    });

    // Step 1: room lookup from the handle (what prewarm/send does first).
    console.log(`[${ms()}] resolving room id for @${uniqueId} ...`);
    const roomId = await connection.fetchRoomId(uniqueId);
    console.log(`[${ms()}] roomId=${roomId}`);

    // Step 2: live status.
    const isLive = await connection.fetchIsLive();
    console.log(`[${ms()}] isLive=${isLive}`);
    if (!isLive) {
        console.log('stream is offline - nothing to watch');
        process.exit(2);
    }

    // Step 3: connect to the chat WebSocket and observe comments.
    let chats = 0;
    connection.on(WebcastEvent.CHAT, (data: { uniqueId?: string; comment?: string }) => {
        chats += 1;
        console.log(`[${ms()}] chat #${chats} ${data.uniqueId}: ${data.comment}`);
    });

    await connection.connect(roomId);
    console.log(`[${ms()}] connected to live chat, watching ${WATCH_MS / 1000}s ...`);

    await new Promise((resolve) => setTimeout(resolve, WATCH_MS));

    console.log(`[${ms()}] done: observed ${chats} chat message(s)`);
    connection.disconnect();
    process.exit(chats > 0 || isLive ? 0 : 3);
}

main().catch((error) => {
    console.error('FAILED:', error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exit(1);
});
