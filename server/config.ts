export type SendProvider = 'webcast' | 'euler';

export interface ServerConfig {
    host: string;
    port: number;
    accessToken: string;
    dryRun: boolean;
    echoEnabled: boolean;
    echoTimeoutMs: number;
    echoIdleMs: number;
    sendIntervalMs: number;
    sendMaxPerMinute: number;
    roomCacheTtlMs: number;
    providerTimeoutMs: number;
    eulerApiKey: string | null;
    sendProvider: SendProvider;
    tiktokSessionId: string | null;
    tiktokTtTargetIdc: string | null;
    senderUniqueId: string | null;
}

const MIN_ACCESS_TOKEN_LENGTH = 16;
const MAX_CONTENT_LENGTH = 150;

export { MAX_CONTENT_LENGTH };

function readString(env: NodeJS.ProcessEnv, name: string): string | null {
    const value = env[name];
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
}

function readBoolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
    const value = readString(env, name);
    if (value === null) return fallback;
    return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function readInteger(
    env: NodeJS.ProcessEnv,
    name: string,
    fallback: number,
    min: number,
    max: number,
    problems: string[]
): number {
    const value = readString(env, name);
    if (value === null) return fallback;

    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
        problems.push(`${name} phải là số nguyên trong khoảng ${min}..${max}.`);
        return fallback;
    }
    return parsed;
}

function readSenderUniqueId(env: NodeJS.ProcessEnv): string | null {
    const value = readString(env, 'SENDER_UNIQUE_ID');
    return value === null ? null : value.replace(/^@/, '').toLowerCase();
}

/**
 * Parse and validate the environment. Failing closed is intentional: an
 * incomplete configuration must not start a server that pretends to send.
 */
export function loadConfig(env: NodeJS.ProcessEnv): ServerConfig {
    const problems: string[] = [];

    const accessToken = readString(env, 'APP_TOKEN');
    if (accessToken === null) {
        problems.push('Thiếu APP_TOKEN (token truy cập do app desktop gửi kèm).');
    } else if (accessToken.length < MIN_ACCESS_TOKEN_LENGTH) {
        problems.push(`APP_TOKEN phải dài ít nhất ${MIN_ACCESS_TOKEN_LENGTH} ký tự.`);
    }

    const dryRun = readBoolean(env, 'SEND_DRY_RUN', false);
    const eulerApiKey = readString(env, 'EULER_API_KEY');
    const tiktokSessionId = readString(env, 'TIKTOK_SESSION_ID');
    const tiktokTtTargetIdc = readString(env, 'TIKTOK_TT_TARGET_IDC');

    // Sending by default goes straight to TikTok's webcast API with the
    // session cookies, so no paid key is required. `euler` opts back into the
    // paid relay and therefore needs its key.
    const sendProviderRaw = (readString(env, 'SEND_PROVIDER') ?? 'webcast').toLowerCase();
    let sendProvider: SendProvider = 'webcast';
    if (sendProviderRaw === 'webcast' || sendProviderRaw === 'euler') {
        sendProvider = sendProviderRaw;
    } else {
        problems.push("SEND_PROVIDER phải là 'webcast' hoặc 'euler'.");
    }

    if (!dryRun && sendProvider === 'euler' && eulerApiKey === null) {
        problems.push('SEND_PROVIDER=euler yêu cầu EULER_API_KEY (gói trả phí); '
            + "bỏ SEND_PROVIDER để gửi thẳng qua webcast (không mất phí).");
    }

    // The session may also arrive at runtime via PUT /api/session (desktop
    // login window), so it is optional at startup — but the pair must match,
    // because the cookie jar rejects sessionId without tt-target-idc.
    if ((tiktokSessionId === null) !== (tiktokTtTargetIdc === null)) {
        problems.push('TIKTOK_SESSION_ID và TIKTOK_TT_TARGET_IDC phải điền cùng nhau, '
            + 'hoặc bỏ trống cả hai để nhận phiên sau qua PUT /api/session.');
    }

    const config: ServerConfig = {
        host: readString(env, 'HOST') ?? '127.0.0.1',
        port: readInteger(env, 'PORT', 3001, 1, 65535, problems),
        accessToken: accessToken ?? '',
        dryRun,
        echoEnabled: readBoolean(env, 'ECHO_CONFIRM', true) && !dryRun,
        echoTimeoutMs: readInteger(env, 'ECHO_TIMEOUT_MS', 10_000, 1_000, 60_000, problems),
        echoIdleMs: readInteger(env, 'ECHO_IDLE_MS', 120_000, 5_000, 600_000, problems),
        sendIntervalMs: readInteger(env, 'SEND_MIN_INTERVAL_MS', 2_000, 0, 60_000, problems),
        sendMaxPerMinute: readInteger(env, 'SEND_MAX_PER_MINUTE', 20, 1, 120, problems),
        roomCacheTtlMs: readInteger(env, 'ROOM_CACHE_TTL_MS', 60_000, 0, 3_600_000, problems),
        providerTimeoutMs: readInteger(env, 'PROVIDER_TIMEOUT_MS', 15_000, 1_000, 60_000, problems),
        eulerApiKey,
        sendProvider,
        tiktokSessionId,
        tiktokTtTargetIdc,
        senderUniqueId: readSenderUniqueId(env)
    };

    if (problems.length > 0) {
        throw new Error(`Cấu hình backend chưa hợp lệ:\n- ${problems.join('\n- ')}`);
    }

    return config;
}
