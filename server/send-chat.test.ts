import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
    FetchSignedWebSocketIdentityParameterError,
    TikTokLiveConnection,
    TikTokWebClient
} from '../src/index';

interface RecordedRequest {
    path: string;
    method?: string;
    params: Record<string, string>;
    signRequest?: boolean;
}

interface CannedReply {
    status: number;
    data: unknown;
}

/**
 * A web client whose HTTP layer is replaced by a canned queue, so the send
 * route can be exercised without touching TikTok.
 */
function createWebClient(replies: CannedReply[]): { client: TikTokWebClient; calls: RecordedRequest[] } {
    const client = new TikTokWebClient();
    const calls: RecordedRequest[] = [];
    let index = 0;

    client.request = ((args: any) => {
        calls.push({
            path: args.path,
            method: args.method,
            params: args.params,
            signRequest: args.signRequest
        });
        const reply = replies[Math.min(index, replies.length - 1)];
        index += 1;
        return Promise.resolve({ status: reply.status, data: reply.data });
    }) as any;

    return { client, calls };
}

const session = { sessionId: 'session-1', ttTargetIdc: 'useast1a' };

describe('sendRoomChatWebcast', () => {

    test('posts the comment straight to webcast with the account session', async () => {
        const { client, calls } = createWebClient([{ status: 200, data: { status_code: 0, data: { id: '1' } } }]);

        const result = await client.sendRoomChatWebcast({
            roomId: '7701346099785255698',
            content: 'xin chao',
            ...session
        });

        assert.equal(result.code, 0);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].path, 'webcast/room/chat/');
        assert.equal(calls[0].method, 'POST');
        assert.equal(calls[0].signRequest, false);
        assert.equal(calls[0].params.room_id, '7701346099785255698');
        assert.equal(calls[0].params.content, 'xin chao');
        assert.equal(client.cookieJar.sessionId, session.sessionId);
        assert.equal(client.cookieJar.ttTargetIdc, session.ttTargetIdc);
    });

    test('refuses a sessionId without tt-target-idc', async () => {
        const { client } = createWebClient([{ status: 200, data: { status_code: 0 } }]);
        // The jar ships with a default tt-target-idc; drop it so only the
        // session half of the pair remains.
        delete client.cookieJar.cookies['tt-target-idc'];

        await assert.rejects(
            client.sendRoomChatWebcast({ roomId: '1', content: 'hi', sessionId: 'session-1', ttTargetIdc: null }),
            (error: unknown) => error instanceof FetchSignedWebSocketIdentityParameterError
        );
    });

    test('reports an expired session as such', async () => {
        const { client, calls } = createWebClient([{ status: 200, data: { status_code: 20003 } }]);

        await assert.rejects(
            client.sendRoomChatWebcast({ roomId: '1', content: 'hi', ...session }),
            /session/
        );
        assert.equal(calls.length, 1);
    });

    test('surfaces a business error status from TikTok', async () => {
        const { client } = createWebClient([{ status: 200, data: { status_code: 40001, message: 'nope' } }]);

        await assert.rejects(
            client.sendRoomChatWebcast({ roomId: '1', content: 'hi', ...session }),
            /40001.*nope/
        );
    });

    test('keeps the reason TikTok gives when it answers 403', async () => {
        const { client } = createWebClient([{ status: 403, data: 'blocked by anti-bot check' }]);

        await assert.rejects(
            client.sendRoomChatWebcast({ roomId: '1', content: 'hi', ...session }),
            /TikTok answered HTTP 403.*blocked by anti-bot check/
        );
    });

    test('falls back to the publish endpoint when room/chat is gone', async () => {
        const { client, calls } = createWebClient([
            { status: 404, data: 'Not Found' },
            { status: 200, data: { status_code: 0 } }
        ]);

        const result = await client.sendRoomChatWebcast({ roomId: '1', content: 'hi', ...session });

        assert.equal(result.code, 0);
        assert.deepEqual(calls.map((call) => call.path), [
            'webcast/room/chat/',
            'webcast/comment/publish/'
        ]);
    });

    test('does not report an ambiguous 2xx JSON body as a failure', async () => {
        const { client } = createWebClient([{ status: 200, data: { accepted: true } }]);

        const result = await client.sendRoomChatWebcast({ roomId: '1', content: 'hi', ...session });
        assert.equal(result.code, 0);
    });

});

describe('sendMessage provider selection', () => {

    async function captureProvider(options: Parameters<typeof buildConnection>[0]): Promise<string> {
        const connection = buildConnection(options);
        let used: string | null = null;

        const webClient = connection.webClient as any;
        webClient.sendRoomChatWebcast = async () => {
            used = 'webcast';
            return { code: 0 };
        };
        webClient.sendRoomChatFromEuler = async () => {
            used = 'euler';
            return { code: 0 };
        };

        await connection.sendMessage('hi', { roomId: '123' });
        assert.notEqual(used, null);
        return used as string;
    }

    function buildConnection(options: { sendProvider?: 'webcast' | 'euler'; signApiKey?: string | null } = {}): TikTokLiveConnection {
        return new TikTokLiveConnection('someone', {
            sessionId: session.sessionId,
            ttTargetIdc: session.ttTargetIdc,
            signApiKey: options.signApiKey ?? null,
            sendProvider: options.sendProvider
        });
    }

    test('defaults to the free webcast route', async () => {
        assert.equal(await captureProvider({}), 'webcast');
    });

    test('keeps the paid Euler route available when asked', async () => {
        assert.equal(await captureProvider({ sendProvider: 'euler', signApiKey: 'key' }), 'euler');
    });

});
