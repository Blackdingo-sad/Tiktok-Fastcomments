export interface TikTokSession {
    sessionId: string;
    ttTargetIdc: string;
}

export interface SessionStore {
    /** Current session, or null until one arrives from .env or PUT /api/session. */
    get(): TikTokSession | null;
    set(session: TikTokSession): void;
    configured(): boolean;
}

/**
 * Holds the TikTok login of the commenting account.
 *
 * The session is deliberately never serialized anywhere: no disk, no logs, no
 * response bodies. It arrives either from server/.env at startup or from the
 * desktop app over PUT /api/session, and the live adapters read it right
 * before each send so a rotated login takes effect immediately.
 */
export function createSessionStore(
    initial: { sessionId: string | null; ttTargetIdc: string | null }
): SessionStore {
    let current: TikTokSession | null =
        initial.sessionId !== null && initial.ttTargetIdc !== null
            ? { sessionId: initial.sessionId, ttTargetIdc: initial.ttTargetIdc }
            : null;

    return {
        get: () => current,
        set: (session) => {
            current = { sessionId: session.sessionId, ttTargetIdc: session.ttTargetIdc };
        },
        configured: () => current !== null
    };
}
