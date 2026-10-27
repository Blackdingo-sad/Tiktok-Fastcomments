export interface EchoChatData {
    comment?: unknown;
    user?: { uniqueId?: unknown } | null;
    common?: { msgId?: unknown } | null;
}

/**
 * The slice of a read-only connection that echo confirmation needs. Keeping it
 * this small lets the confirmation logic be tested without a live room.
 */
export interface EchoConnection {
    onChat(handler: (data: EchoChatData) => void): void;
    onClosed(handler: () => void): void;
    connect(): Promise<unknown>;
    disconnect(): Promise<void>;
}

export type EchoConnectionFactory = (uniqueId: string) => EchoConnection;

export interface EchoResult {
    confirmed: boolean;
    appearedMs: number | null;
    reason: string | null;
}

export interface EchoExpectation {
    promise: Promise<EchoResult>;
    /** Record the moment the send was started; latency is measured from here. */
    markSent(at: number): void;
    cancel(reason: string): void;
}

export interface EchoConfirmerOptions {
    createConnection: EchoConnectionFactory;
    idleMs: number;
    senderUniqueId?: string | null;
    log?: (message: string) => void;
    now?: () => number;
}

interface Waiter {
    armedAt: number;
    sentAt: number | null;
    done: boolean;
    matches: (data: EchoChatData) => boolean;
    timer: ReturnType<typeof setTimeout> | null;
    resolve: (result: EchoResult) => void;
}

type WatcherState = 'connecting' | 'ready' | 'failed';

interface Watcher {
    uniqueId: string;
    connection: EchoConnection;
    state: WatcherState;
    waiters: Set<Waiter>;
    seenMessages: Set<string>;
    idleTimer: ReturnType<typeof setTimeout> | null;
    disposed: boolean;
}

const MAX_SEEN_MESSAGES = 500;

function normalizeText(value: string): string {
    return value
        .normalize('NFC')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeUniqueId(value: unknown): string {
    return typeof value === 'string' ? value.replace(/^@/, '').trim().toLowerCase() : '';
}

function unavailable(reason: string): Promise<EchoResult> {
    return Promise.resolve({ confirmed: false, appearedMs: null, reason });
}

/**
 * Watches a room over a read-only WebSocket and reports when the comment that
 * was just sent comes back through the chat. This is the only signal in the app
 * that shows what TikTok actually displayed; it is best-effort by nature, so a
 * missing echo is reported as unconfirmed rather than as a failure.
 */
export class EchoConfirmer {

    private readonly watchers = new Map<string, Watcher>();
    private readonly now: () => number;
    private readonly log: (message: string) => void;

    constructor(private readonly options: EchoConfirmerOptions) {
        this.now = options.now ?? Date.now;
        this.log = options.log ?? (() => {});
    }

    /**
     * Open (or reuse) the read-only connection for a room. Returns false when
     * the connection is not ready in time; callers then skip confirmation.
     */
    async warm(uniqueId: string, timeoutMs: number): Promise<boolean> {
        const watcher = this.ensureWatcher(uniqueId);
        if (watcher === null) return false;
        if (watcher.state === 'ready') return true;
        if (watcher.state === 'failed') return false;

        const ready = await Promise.race([
            watcherStateSettled(watcher),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs))
        ]);

        return ready && readState(watcher) === 'ready';
    }

    expect(uniqueId: string, content: string, timeoutMs: number): EchoExpectation {
        // Start the read-only connection if needed, but never wait for it here:
        // the waiter can resolve as soon as the connection is up.
        const watcher = this.ensureWatcher(uniqueId);
        if (watcher === null || watcher.disposed || watcher.state === 'failed') {
            return {
                promise: unavailable('echo_unavailable'),
                markSent: () => {},
                cancel: () => {}
            };
        }

        const target = normalizeText(content);
        const expectedSender = normalizeUniqueId(this.options.senderUniqueId);

        const matches = (data: EchoChatData): boolean => {
            if (typeof data?.comment !== 'string') return false;
            if (normalizeText(data.comment) !== target) return false;
            if (expectedSender !== '') {
                return normalizeUniqueId(data.user?.uniqueId) === expectedSender;
            }
            return true;
        };

        let resolveWaiter: (result: EchoResult) => void = () => {};
        const promise = new Promise<EchoResult>((resolve) => {
            resolveWaiter = resolve;
        });

        const waiter: Waiter = {
            armedAt: this.now(),
            sentAt: null,
            done: false,
            matches,
            timer: null,
            resolve: resolveWaiter
        };

        waiter.timer = setTimeout(() => {
            this.finish(watcher, waiter, { confirmed: false, appearedMs: null, reason: 'timeout' });
        }, timeoutMs);

        watcher.waiters.add(waiter);

        return {
            promise,
            markSent: (at: number) => {
                if (!waiter.done) waiter.sentAt = at;
            },
            cancel: (reason: string) => {
                this.finish(watcher, waiter, { confirmed: false, appearedMs: null, reason });
            }
        };
    }

    async close(): Promise<void> {
        for (const watcher of [...this.watchers.values()]) {
            this.dispose(watcher, 'server_shutdown');
        }
    }

    private ensureWatcher(uniqueId: string): Watcher | null {
        const existing = this.watchers.get(uniqueId);
        if (existing !== undefined && !existing.disposed) return existing;

        let connection: EchoConnection;
        try {
            connection = this.options.createConnection(uniqueId);
        } catch (error) {
            this.log(`echo: không tạo được kết nối cho ${uniqueId}: ${errorMessage(error)}`);
            return null;
        }

        const watcher: Watcher = {
            uniqueId,
            connection,
            state: 'connecting',
            waiters: new Set(),
            seenMessages: new Set(),
            idleTimer: null,
            disposed: false
        };

        connection.onChat((data) => this.handleChat(watcher, data));
        connection.onClosed(() => this.dispose(watcher, 'connection_closed'));
        this.watchers.set(uniqueId, watcher);

        Promise.resolve()
            .then(() => connection.connect())
            .then(() => {
                if (watcher.disposed) return;
                watcher.state = 'ready';
                this.scheduleIdle(watcher);
            })
            .catch((error) => {
                if (watcher.disposed) return;
                watcher.state = 'failed';
                this.log(`echo: không kết nối được phòng ${uniqueId}: ${errorMessage(error)}`);
                this.dispose(watcher, 'echo_unavailable');
            });

        return watcher;
    }

    private handleChat(watcher: Watcher, data: EchoChatData): void {
        if (watcher.disposed) return;

        const messageId = typeof data?.common?.msgId === 'string' ? data.common.msgId : null;
        if (messageId !== null) {
            if (watcher.seenMessages.has(messageId)) return;
            if (watcher.seenMessages.size >= MAX_SEEN_MESSAGES) {
                const oldest = watcher.seenMessages.values().next().value;
                if (oldest !== undefined) watcher.seenMessages.delete(oldest);
            }
            watcher.seenMessages.add(messageId);
        }

        for (const waiter of [...watcher.waiters]) {
            if (waiter.done || !waiter.matches(data)) continue;
            const since = waiter.sentAt ?? waiter.armedAt;
            this.finish(watcher, waiter, {
                confirmed: true,
                appearedMs: Math.max(0, this.now() - since),
                reason: null
            });
        }
    }

    private finish(watcher: Watcher, waiter: Waiter, result: EchoResult): void {
        if (waiter.done) return;
        waiter.done = true;
        if (waiter.timer !== null) clearTimeout(waiter.timer);
        waiter.timer = null;
        watcher.waiters.delete(waiter);
        waiter.resolve(result);
        this.scheduleIdle(watcher);
    }

    private scheduleIdle(watcher: Watcher): void {
        if (watcher.disposed || watcher.waiters.size > 0) return;
        if (watcher.idleTimer !== null) clearTimeout(watcher.idleTimer);
        watcher.idleTimer = setTimeout(() => {
            if (watcher.waiters.size === 0) this.dispose(watcher, 'idle');
        }, this.options.idleMs);
        watcher.idleTimer.unref?.();
    }

    private dispose(watcher: Watcher, reason: string): void {
        if (watcher.disposed) return;
        watcher.disposed = true;
        watcher.state = 'failed';

        if (watcher.idleTimer !== null) clearTimeout(watcher.idleTimer);
        watcher.idleTimer = null;

        if (this.watchers.get(watcher.uniqueId) === watcher) {
            this.watchers.delete(watcher.uniqueId);
        }

        for (const waiter of [...watcher.waiters]) {
            this.finish(watcher, waiter, { confirmed: false, appearedMs: null, reason });
        }

        watcher.seenMessages.clear();
        Promise.resolve()
            .then(() => watcher.connection.disconnect())
            .catch(() => {});
    }

}

function readState(watcher: Watcher): WatcherState {
    return watcher.state;
}

function watcherStateSettled(watcher: Watcher): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        const check = () => {
            if (watcher.state === 'ready') return resolve(true);
            if (watcher.state === 'failed') return resolve(false);
            setTimeout(check, 25).unref?.();
        };
        check();
    });
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
