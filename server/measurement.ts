import { createHash, randomUUID } from 'node:crypto';

export interface SendMarker {
    id: string;
    contentHash: string;
    sentAtMs: number;
}

export interface ObservedComment {
    user: string;
    text: string;
    receivedAtMs: number;
}

export interface MeasurementResult {
    sendId: string;
    elapsedMs: number;
}

export function hashComment(content: string): string {
    const normalized = content.normalize('NFC').replace(/\s+/g, ' ').trim();
    return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

export function correlateSendMarker(
    marker: SendMarker,
    comment: ObservedComment,
    senderUniqueId: string
): MeasurementResult | null {
    if (comment.user.toLowerCase() !== senderUniqueId.toLowerCase()
        || hashComment(comment.text) !== marker.contentHash) return null;

    const elapsedMs = comment.receivedAtMs - marker.sentAtMs;
    if (elapsedMs < 0 || elapsedMs > 30_000) return null;
    return { sendId: marker.id, elapsedMs };
}

export function createSendMarker(content: string, sentAtMs = Date.now()): SendMarker {
    return {
        id: randomUUID(),
        contentHash: hashComment(content),
        sentAtMs
    };
}

export function isSendMarker(value: unknown): value is SendMarker {
    if (typeof value !== 'object' || value === null) return false;
    const marker = value as Record<string, unknown>;
    return typeof marker.id === 'string'
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(marker.id)
        && typeof marker.contentHash === 'string'
        && /^[0-9a-f]{64}$/i.test(marker.contentHash)
        && typeof marker.sentAtMs === 'number'
        && Number.isSafeInteger(marker.sentAtMs)
        && marker.sentAtMs > 0;
}
