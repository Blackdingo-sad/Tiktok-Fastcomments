import { AxiosRequestConfig, AxiosResponse } from 'axios';
import { IWebcastRoomChatRouteResponse } from '@eulerstream/euler-api-sdk';
import { Route } from '@/types/route';
import { FetchSignedWebSocketIdentityParameterError } from '@/types';
import Config from '@/lib/config';

export type SendRoomChatWebcastRouteParams = {
    roomId: string;
    content: string;
    sessionId?: string | null;
    ttTargetIdc?: string | null;
    options?: AxiosRequestConfig;
};

/**
 * Webcast endpoints that publish a chat message directly against TikTok,
 * without routing the request (and the session cookie) through a paid
 * third-party relay. `webcast/room/chat/` is the route TikTok's own web client
 * used; `webcast/comment/publish/` is the newer webcast publish route. Both are
 * tried in order so an endpoint rename does not hard-fail the send.
 */
const SEND_PATHS = ['webcast/room/chat/', 'webcast/comment/publish/'];

/** TikTok's "session expired / please log in again" business status. */
const STATUS_SESSION_EXPIRED = 20003;

interface WebcastChatBody {
    status_code?: number;
    code?: number;
    message?: string;
    data?: any;
}

function isObjectBody(value: unknown): value is WebcastChatBody {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Long enough to carry TikTok's reason, short enough to read in the app. */
const MAX_DIAGNOSTIC_LENGTH = 240;

/**
 * On a rejection the response body is the only clue left: it carries either a
 * business status or the anti-bot page reason. Keep a short single-line copy so
 * the operator sees why TikTok refused instead of a bare status code.
 */
function describeResponseBody(response: AxiosResponse): string {
    const data = response.data;
    let text: string;

    if (typeof data === 'string') {
        text = data;
    } else if (data !== undefined && data !== null) {
        try {
            text = JSON.stringify(data);
        } catch {
            return '';
        }
    } else {
        return '';
    }

    const compact = text.replace(/\s+/g, ' ').trim();
    if (compact === '') return '';
    return compact.length > MAX_DIAGNOSTIC_LENGTH
        ? `${compact.slice(0, MAX_DIAGNOSTIC_LENGTH)}…`
        : compact;
}

/**
 * Publish a chat message directly to TikTok's webcast API using the session
 * cookies of the commenting account. No API key and no paid plan: the only
 * credential is the user's own TikTok session, which already has to exist for
 * the comment to be posted under that account.
 */
export class SendRoomChatWebcastRoute extends Route<SendRoomChatWebcastRouteParams, IWebcastRoomChatRouteResponse> {

    async call(
        {
            roomId,
            content,
            sessionId,
            ttTargetIdc,
            options
        }: SendRoomChatWebcastRouteParams
    ): Promise<IWebcastRoomChatRouteResponse> {

        const resolvedSessionId = sessionId || this.webClient.cookieJar.sessionId;
        const resolvedTtTargetIdc = ttTargetIdc || this.webClient.cookieJar.ttTargetIdc;

        if (!resolvedSessionId) {
            throw new Error('Session ID is required to send a message.');
        }

        if (!resolvedTtTargetIdc) {
            throw new FetchSignedWebSocketIdentityParameterError(
                'ttTargetIdc must be set when sessionId is provided.'
            );
        }

        // The comment must be posted by the logged-in account, so make sure the
        // jar carries both cookies before the request goes out.
        this.webClient.cookieJar.setSession(resolvedSessionId, resolvedTtTargetIdc);

        const params: Record<string, string> = {
            ...this.webClient.clientParams,
            room_id: roomId,
            content
        };

        for (const path of SEND_PATHS) {
            let response = await this.post(path, params, false, options);

            // TikTok asking for credentials on an unsigned request is the only
            // case where signing can help. The signer is free-tier, so retry the
            // same endpoint signed once; if signing itself fails, keep the
            // original response so the caller still sees TikTok's answer.
            if (response.status === 401 || response.status === 403) {
                response = await this.post(path, params, true, options) ?? response;
            }

            const body = isObjectBody(response.data) ? response.data : null;
            const status = body !== null
                ? (typeof body.status_code === 'number' ? body.status_code
                    : typeof body.code === 'number' ? body.code : null)
                : null;

            if (status !== null) {
                if (status === 0) {
                    return { code: 0, message: body.message, data: body.data };
                }
                if (status === STATUS_SESSION_EXPIRED) {
                    throw new Error(
                        'TikTok session has expired (status 20003): sign in again before sending.'
                    );
                }
                throw new Error(
                    `TikTok rejected the comment (status ${status})${body.message ? `: ${body.message}` : '.'}`
                );
            }

            // No recognisable payload: the endpoint is gone on this path.
            if (response.status === 404 || response.status === 405) continue;

            // A 2xx JSON answer without a status field is accepted as-is rather
            // than reported as a failure the user might retry into a duplicate.
            if (response.status >= 200 && response.status < 300 && body !== null) {
                return { code: 0, data: body };
            }

            const detail = describeResponseBody(response);
            throw new Error(`TikTok answered HTTP ${response.status} when sending via ${path}.`
                + (detail === '' ? '' : ` TikTok said: ${detail}`));
        }

        throw new Error('No TikTok webcast endpoint accepted the comment.');
    }

    private async post(
        path: string,
        params: Record<string, string>,
        signRequest: boolean,
        options?: AxiosRequestConfig
    ): Promise<AxiosResponse | null> {
        try {
            return await this.webClient.request({
                host: Config.TIKTOK_HOST_WEBCAST,
                path: path,
                params: params,
                method: 'POST',
                signRequest: signRequest,
                responseType: 'json',
                validateStatus: () => true,
                ...options
            });
        } catch (error) {
            if (!signRequest) throw error;
            // Signing is an optional improvement, never a hard requirement.
            return null;
        }
    }

}
