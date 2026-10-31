import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
    correlateSendMarker,
    createSendMarker,
    hashComment,
    isSendMarker
} from './measurement';

describe('manual-send measurement markers', () => {
    test('hashes whitespace-normalized comment text without storing the text', () => {
        assert.equal(hashComment('  xin   chào\nshop  '), hashComment('xin chào shop'));
        assert.notEqual(hashComment('xin chào shop'), hashComment('xin chào bạn'));
    });

    test('creates a valid marker with its send timestamp', () => {
        const marker = createSendMarker('giá 199k', 1_798_000_000_000);

        assert.equal(marker.sentAtMs, 1_798_000_000_000);
        assert.equal(marker.contentHash, hashComment('giá 199k'));
        assert.equal(isSendMarker(marker), true);
    });

    test('rejects malformed or unsafe marker fields', () => {
        assert.equal(isSendMarker(null), false);
        assert.equal(isSendMarker({ id: 'x', contentHash: 'x', sentAtMs: Date.now() }), false);
        assert.equal(isSendMarker({
            ...createSendMarker('x'),
            sentAtMs: Number.POSITIVE_INFINITY
        }), false);
    });

    test('correlates only the exact sender and matching comment within the measurement window', () => {
        const marker = createSendMarker('giá 199k', 10_000);

        assert.deepEqual(correlateSendMarker(marker, {
            user: 'SHOPPER',
            text: 'giá 199k',
            receivedAtMs: 10_245
        }, 'shopper'), { sendId: marker.id, elapsedMs: 245 });
        assert.equal(correlateSendMarker(marker, {
            user: 'someone-else',
            text: 'giá 199k',
            receivedAtMs: 10_245
        }, 'shopper'), null);
        assert.equal(correlateSendMarker(marker, {
            user: 'shopper',
            text: 'giá 199k',
            receivedAtMs: 9_999
        }, 'shopper'), null);
    });
});
