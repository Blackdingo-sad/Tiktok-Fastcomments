import type { ServerResponse } from 'node:http';

export interface EchoEvent {
    requestId: string;
    uniqueId: string;
    confirmed: boolean;
    appearedMs: number | null;
    echoReason: string | null;
}

const HEARTBEAT_MS = 15_000;

/**
 * Fan-out for echo results. The desktop app is a single operator, so one
 * process-wide hub is enough; events are also harmless if nobody is listening.
 */
export class EchoHub {

    private readonly clients = new Set<ServerResponse>();
    private readonly heartbeat: NodeJS.Timeout;

    constructor() {
        this.heartbeat = setInterval(() => {
            for (const client of this.clients) {
                try {
                    client.write(': ping\n\n');
                } catch {
                    this.clients.delete(client);
                }
            }
        }, HEARTBEAT_MS);
        this.heartbeat.unref?.();
    }

    subscribe(res: ServerResponse): void {
        this.clients.add(res);
        res.write('retry: 2000\n\n');
        res.on('close', () => this.clients.delete(res));
    }

    publish(event: EchoEvent): void {
        const payload = `event: echo\ndata: ${JSON.stringify(event)}\n\n`;
        for (const client of [...this.clients]) {
            try {
                client.write(payload);
            } catch {
                this.clients.delete(client);
            }
        }
    }

    close(): void {
        clearInterval(this.heartbeat);
        for (const client of this.clients) {
            try {
                client.end();
            } catch {
                // already closed
            }
        }
        this.clients.clear();
    }

}
