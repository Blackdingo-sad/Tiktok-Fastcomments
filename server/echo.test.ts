import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EchoConfirmer, type EchoChatData, type EchoConnection } from './echo';

class FakeConnection implements EchoConnection {

    public connects = 0;
    public disconnects = 0;
    public connectError: Error | null = null;

    private chatHandlers: Array<(data: EchoChatData) => void> = [];
    private closedHandlers: Array<() => void> = [];

    onChat(handler: (data: EchoChatData) => void): void {
        this.chatHandlers.push(handler);
    }

    onClosed(handler: () => void): void {
        this.closedHandlers.push(handler);
    }

    async connect(): Promise<void> {
        this.connects += 1;
        if (this.connectError !== null) throw this.connectError;
    }

    async disconnect(): Promise<void> {
        this.disconnects += 1;
    }

    emitChat(data: EchoChatData): void {
        for (const handler of this.chatHandlers) handler(data);
    }

    emitClosed(): void {
        for (const handler of this.closedHandlers) handler();
    }

}

function createHarness(options: { senderUniqueId?: string | null } = {}) {
    let clock = 1_000;
    const connection = new FakeConnection();
    const confirmer = new EchoConfirmer({
        createConnection: () => connection,
        idleMs: 60_000,
        senderUniqueId: options.senderUniqueId ?? null,
        now: () => clock
    });

    return {
        confirmer,
        connection,
        setClock(value: number) {
            clock = value;
        }
    };
}

describe('echo confirmation', () => {

    test('confirms when the sent comment comes back, measuring from the send', async () => {
        const { confirmer, connection, setClock } = createHarness();

        assert.equal(await confirmer.warm('someone', 500), true);

        const expectation = confirmer.expect('someone', 'Xin chào', 500);
        setClock(1_400);
        expectation.markSent(1_400);
        setClock(1_650);

        connection.emitChat({
            comment: '  Xin   chào ',
            common: { msgId: 'm1' },
            user: { uniqueId: 'buyer' }
        });

        assert.deepEqual(await expectation.promise, {
            confirmed: true,
            appearedMs: 250,
            reason: null
        });

        await confirmer.close();
    });

    test('reports a timeout when the comment never appears', async () => {
        const { confirmer } = createHarness();
        assert.equal(await confirmer.warm('someone', 500), true);

        const expectation = confirmer.expect('someone', 'not echoed', 40);
        expectation.markSent(1_000);

        assert.deepEqual(await expectation.promise, {
            confirmed: false,
            appearedMs: null,
            reason: 'timeout'
        });

        await confirmer.close();
    });

    test('ignores matching text from another sender when a sender is configured', async () => {
        const { confirmer, connection, setClock } = createHarness({ senderUniqueId: '@Me' });
        assert.equal(await confirmer.warm('someone', 500), true);

        const expectation = confirmer.expect('someone', 'hello', 500);
        setClock(1_100);
        expectation.markSent(1_100);

        connection.emitChat({ comment: 'hello', common: { msgId: 'a' }, user: { uniqueId: 'other' } });
        connection.emitChat({ comment: 'hello', common: { msgId: 'b' }, user: { uniqueId: 'me' } });

        const result = await expectation.promise;
        assert.equal(result.confirmed, true);
        assert.equal(result.appearedMs, 0);

        await confirmer.close();
    });

    test('reports echo as unavailable when the read-only connection cannot open', async () => {
        const { confirmer, connection } = createHarness();
        connection.connectError = new Error('offline');

        assert.equal(await confirmer.warm('someone', 500), false);
        assert.deepEqual(await confirmer.expect('someone', 'hello', 500).promise, {
            confirmed: false,
            appearedMs: null,
            reason: 'echo_unavailable'
        });

        await confirmer.close();
    });

    test('resolves pending expectations when the read-only connection drops', async () => {
        const { confirmer, connection } = createHarness();
        assert.equal(await confirmer.warm('someone', 500), true);

        const expectation = confirmer.expect('someone', 'hello', 1_000);
        connection.emitClosed();

        assert.deepEqual(await expectation.promise, {
            confirmed: false,
            appearedMs: null,
            reason: 'connection_closed'
        });

        await confirmer.close();
    });

    test('cancel unblocks a waiting expectation after a failed send', async () => {
        const { confirmer } = createHarness();
        assert.equal(await confirmer.warm('someone', 500), true);

        const expectation = confirmer.expect('someone', 'hello', 1_000);
        expectation.cancel('send_failed');

        assert.deepEqual(await expectation.promise, {
            confirmed: false,
            appearedMs: null,
            reason: 'send_failed'
        });

        await confirmer.close();
    });

    test('retries the read-only connection on the next warm after a failure', async () => {
        const { confirmer, connection } = createHarness();
        connection.connectError = new Error('offline');
        assert.equal(await confirmer.warm('someone', 200), false);

        connection.connectError = null;
        assert.equal(await confirmer.warm('someone', 500), true);
        assert.equal(connection.connects, 2);

        await confirmer.close();
    });

});
