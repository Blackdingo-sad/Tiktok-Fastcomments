const { app, BrowserWindow, ipcMain, session: electronSession } = require('electron');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { pathToFileURL } = require('node:url');

const REQUEST_TIMEOUT_MS = 10000;
const STREAM_RECONNECT_MS = 1500;
const STREAM_RETRY_AFTER_ERROR_MS = 5000;

const httpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 4 });
const httpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 4 });

let mainWindow = null;
let echoStream = null;
let loginWindow = null;

function getBackendUrl(value) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error('Nhập địa chỉ backend trước.');
    }

    let url;
    try {
        url = new URL(value.trim());
    } catch {
        throw new Error('Địa chỉ backend không hợp lệ.');
    }

    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const isLoopback = hostname === 'localhost'
        || hostname === '127.0.0.1'
        || hostname === '::1';

    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
        throw new Error('Backend phải dùng HTTPS; HTTP chỉ được phép với localhost.');
    }
    if (url.username || url.password || url.search || url.hash) {
        throw new Error('Địa chỉ backend không được chứa thông tin đăng nhập, query hoặc fragment.');
    }

    url.pathname = url.pathname.replace(/\/+$/, '');
    return url;
}

function getAccessToken(value, backendUrl) {
    const token = typeof value === 'string' ? value.trim() : '';
    const hostname = backendUrl.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const isLoopback = hostname === 'localhost'
        || hostname === '127.0.0.1'
        || hostname === '::1';

    if (!isLoopback && !token) {
        throw new Error('Nhập JWT/token truy cập cho backend từ xa.');
    }
    if (/[\r\n]/.test(token)) {
        throw new Error('JWT/token không hợp lệ.');
    }
    return token;
}

function getUniqueId(value) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error('Nhập username TikTok hoặc link LIVE.');
    }

    let raw = value.trim();
    const urlMatch = /^(?:https?:\/\/)?(?:www\.|m\.)?tiktok\.com\/@([A-Za-z0-9._]{1,24})(?:[/?#]|$)/i.exec(raw);
    if (urlMatch) raw = urlMatch[1];
    raw = raw.replace(/^@/, '');

    if (!/^[A-Za-z0-9._]{1,24}$/.test(raw)) {
        throw new Error('Nhập username TikTok hợp lệ hoặc dán link LIVE dạng https://www.tiktok.com/@username/live.');
    }
    return raw;
}

function buildRouteUrl(backendUrl, route) {
    const basePath = backendUrl.pathname.replace(/\/+$/, '');
    const routePath = route.replace(/^\/+/, '');
    return new URL(`${basePath}/${routePath}`, backendUrl.origin);
}

function requestBackend(backendUrl, route, options = {}) {
    const url = buildRouteUrl(backendUrl, route);
    const payload = options.body ? JSON.stringify(options.body) : null;
    const headers = {};
    if (payload !== null) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    if (options.accessToken) headers.Authorization = `Bearer ${options.accessToken}`;

    return new Promise((resolve, reject) => {
        const client = url.protocol === 'https:' ? https : http;
        const request = client.request(url, {
            method: options.method || 'GET',
            headers,
            agent: url.protocol === 'https:' ? httpsAgent : httpAgent
        }, (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => {
                const responseText = Buffer.concat(chunks).toString('utf8');
                const ok = response.statusCode >= 200 && response.statusCode < 300;
                let responseData = null;

                if (responseText !== '') {
                    try {
                        responseData = JSON.parse(responseText);
                    } catch {
                        if (!ok) {
                            reject(new Error(`Backend trả về HTTP ${response.statusCode}: ${responseText.slice(0, 200)}`));
                            return;
                        }
                        if (options.expectJson) {
                            reject(new Error(`Backend trả về dữ liệu không phải JSON (HTTP ${response.statusCode}).`));
                            return;
                        }
                    }
                }

                if (!ok) {
                    const detail = typeof responseData?.error === 'string'
                        ? `: ${responseData.error}`
                        : '';
                    reject(new Error(`Backend trả về HTTP ${response.statusCode}${detail}`));
                    return;
                }

                resolve({ status: response.statusCode, data: responseData });
            });
        });

        request.setTimeout(REQUEST_TIMEOUT_MS, () => {
            const timeoutError = new Error('request_timeout');
            timeoutError.code = 'APP_TIMEOUT';
            request.destroy(timeoutError);
        });

        request.on('error', (error) => {
            if (error?.code === 'APP_TIMEOUT') {
                reject(new Error('Quá thời gian chờ 10 giây; backend có thể đã nhận yêu cầu. Kiểm tra trạng thái trước khi thử lại.'));
                return;
            }
            if (error?.name === 'TypeError' || error?.code === 'ECONNREFUSED' || error?.code === 'ENOTFOUND' || error?.code === 'EAI_AGAIN') {
                reject(new Error('Không kết nối được backend. Kiểm tra địa chỉ, cổng và mạng.'));
                return;
            }
            reject(error);
        });

        if (payload !== null) request.write(payload);
        request.end();
    });
}

function stopEchoStream() {
    const stream = echoStream;
    echoStream = null;
    if (stream === null) return;
    stream.stopped = true;
    if (stream.timer !== null) clearTimeout(stream.timer);
    if (stream.request !== null) stream.request.destroy();
}

function ensureEchoStream(backendUrl, accessToken) {
    const key = `${backendUrl.href}|${accessToken}`;
    if (echoStream !== null && echoStream.key === key && !echoStream.stopped) return;

    stopEchoStream();

    const stream = {
        key,
        stopped: false,
        request: null,
        timer: null
    };
    echoStream = stream;

    const connect = () => {
        if (stream.stopped) return;

        const url = buildRouteUrl(backendUrl, '/api/comments/events');
        const client = url.protocol === 'https:' ? https : http;

        const request = client.get(url, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: 'text/event-stream'
            },
            agent: url.protocol === 'https:' ? httpsAgent : httpAgent
        }, (response) => {
            if (response.statusCode !== 200) {
                response.resume();
                schedule(STREAM_RETRY_AFTER_ERROR_MS);
                return;
            }

            response.setEncoding('utf8');
            let buffer = '';

            response.on('data', (chunk) => {
                buffer += chunk;

                let index = buffer.indexOf('\n\n');
                while (index >= 0) {
                    const block = buffer.slice(0, index);
                    buffer = buffer.slice(index + 2);

                    const data = block
                        .split('\n')
                        .filter((line) => line.startsWith('data: '))
                        .map((line) => line.slice(6))
                        .join('\n');

                    if (data !== '') {
                        try {
                            emitEcho(JSON.parse(data));
                        } catch {
                            // ignore malformed events
                        }
                    }

                    index = buffer.indexOf('\n\n');
                }
            });

            response.on('end', () => schedule(STREAM_RECONNECT_MS));
            response.on('close', () => schedule(STREAM_RECONNECT_MS));
        });

        stream.request = request;
        request.on('error', () => schedule(STREAM_RETRY_AFTER_ERROR_MS));
    };

    const schedule = (delay) => {
        if (stream.stopped) return;
        if (stream.timer !== null) clearTimeout(stream.timer);
        stream.timer = setTimeout(() => {
            stream.timer = null;
            connect();
        }, delay);
    };

    connect();
}

function emitEcho(payload) {
    if (mainWindow === null || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('comment:echo', payload);
}

ipcMain.handle('backend:check', async (_event, backendUrlValue) => {
    const backendUrl = getBackendUrl(backendUrlValue?.backendUrl);
    const accessToken = getAccessToken(backendUrlValue?.accessToken, backendUrl);
    const startedAt = performance.now();
    const healthPromise = requestBackend(backendUrl, '/health', { accessToken });
    const sessionPromise = requestBackend(backendUrl, '/api/session', { accessToken, expectJson: true })
        .then(({ data }) => (data && data.configured === true ? true : false))
        .catch(() => null);
    const health = await healthPromise;

    ensureEchoStream(backendUrl, accessToken);

    return {
        ok: true,
        status: health.status,
        elapsedMs: Math.round(performance.now() - startedAt),
        // true = đã đăng nhập, false = chưa, null = backend cũ / chưa biết.
        sessionConfigured: await sessionPromise
    };
});

ipcMain.handle('comment:prewarm', async (_event, request) => {
    const backendUrl = getBackendUrl(request?.backendUrl);
    const accessToken = getAccessToken(request?.accessToken, backendUrl);
    const uniqueId = getUniqueId(request?.uniqueId);

    ensureEchoStream(backendUrl, accessToken);

    const { data } = await requestBackend(backendUrl, '/api/rooms/prewarm', {
        method: 'POST',
        accessToken,
        expectJson: true,
        body: { uniqueId }
    });

    return {
        ok: true,
        isLive: data && typeof data.isLive === 'boolean' ? data.isLive : null
    };
});

ipcMain.handle('comment:send', async (_event, request) => {
    if (!request || typeof request !== 'object') {
        throw new Error('Dữ liệu bình luận không hợp lệ.');
    }

    const backendUrl = getBackendUrl(request.backendUrl);
    const accessToken = getAccessToken(request.accessToken, backendUrl);
    const uniqueId = getUniqueId(request.uniqueId);
    const content = typeof request.content === 'string' ? request.content.trim() : '';

    if (!content) {
        throw new Error('Nhập nội dung bình luận.');
    }

    ensureEchoStream(backendUrl, accessToken);

    // Marks the moment the user's request left the renderer, before any IPC
    // marshalling. The renderer records it at keydown/submit time; older
    // renderers may not send it, in which case the IPC hand-off is the start.
    const requestEnqueuedAt = typeof request?.clientSentAtMs === 'number'
        && Number.isFinite(request.clientSentAtMs)
        && request.clientSentAtMs > 0
        && request.clientSentAtMs <= Date.now() + 60_000
        ? request.clientSentAtMs
        : Date.now();

    const ipcStartedAtMs = Date.now();
    const startedAt = performance.now();
    const { data } = await requestBackend(backendUrl, '/api/comments', {
        method: 'POST',
        accessToken,
        expectJson: true,
        body: { uniqueId, content }
    });

    if (!data || data.ok !== true) {
        const detail = typeof data?.error === 'string' ? `: ${data.error}` : '';
        throw new Error(`Backend chưa xác nhận đã nhận yêu cầu${detail}`);
    }

    const receivedAtMs = Date.now();

    return {
        ok: true,
        elapsedMs: Math.round(performance.now() - startedAt),
        // Per-stage split, all wall-clock ms: renderer -> IPC hand-off,
        // IPC -> response received, and the backend's own handler time.
        ipcMs: Math.round(ipcStartedAtMs - requestEnqueuedAt),
        responseMs: Math.round(performance.now() - startedAt),
        backendMs: Number.isFinite(data.backendMs) ? data.backendMs : null,
        requestEnqueuedAtMs: requestEnqueuedAt,
        receivedAtMs,
        requestId: typeof data.requestId === 'string' ? data.requestId : null,
        dryRun: data.dryRun === true,
        providerMs: Number.isFinite(data.providerMs) ? data.providerMs : null
    };
});

function findTikTokSessionCookies(cookies) {
    const isTikTok = (cookie) => typeof cookie.domain === 'string' && cookie.domain.includes('tiktok.com');
    const sessionIdCookie = ['sessionid', 'sessionid_ss', 'sid_tt']
        .map((name) => cookies.find((cookie) => cookie.name === name && isTikTok(cookie)))
        .find((cookie) => cookie !== undefined);
    const idcCookie = cookies.find((cookie) => cookie.name === 'tt-target-idc' && isTikTok(cookie));

    return {
        sessionId: sessionIdCookie ? sessionIdCookie.value : null,
        ttTargetIdc: idcCookie ? idcCookie.value : null
    };
}

ipcMain.handle('tiktok:login', async (_event, request) => {
    const backendUrl = getBackendUrl(request?.backendUrl);
    const accessToken = getAccessToken(request?.accessToken, backendUrl);

    if (loginWindow !== null && !loginWindow.isDestroyed()) {
        loginWindow.focus();
        throw new Error('Cửa sổ đăng nhập TikTok đang mở; đăng nhập xong rồi đóng cửa sổ đó.');
    }

    const window = new BrowserWindow({
        width: 520,
        height: 740,
        minWidth: 420,
        minHeight: 560,
        autoHideMenuBar: true,
        backgroundColor: '#0b0d12',
        title: 'Đăng nhập TikTok',
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });
    loginWindow = window;

    // Popups (OAuth) are refused: sign in with email/password or the QR code shown on the page.
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    // Keep the window on TikTok so the captured session provably comes from tiktok.com.
    window.webContents.on('will-navigate', (event, targetUrl) => {
        let hostname = '';
        try {
            hostname = new URL(targetUrl).hostname;
        } catch {
            // Invalid URL: block it.
        }
        const allowed = targetUrl.startsWith('about:')
            || hostname === 'tiktok.com'
            || hostname.endsWith('.tiktok.com');
        if (!allowed) event.preventDefault();
    });

    try {
        await window.loadURL('https://www.tiktok.com/login');
    } catch (error) {
        loginWindow = null;
        window.destroy();
        throw new Error(`Không mở được trang đăng nhập TikTok: ${error.message}`);
    }

    // The user closes the window themselves when the login is done; only then
    // is the cookie jar read (main process only — cookies never reach the renderer).
    await new Promise((resolve) => window.once('closed', resolve));
    loginWindow = null;

    const cookies = await electronSession.defaultSession.cookies.get({});
    const { sessionId, ttTargetIdc } = findTikTokSessionCookies(cookies);
    if (!sessionId || !ttTargetIdc) {
        throw new Error('Chưa bắt được phiên TikTok. Hãy đăng nhập (email/mật khẩu hoặc mã QR) rồi đóng cửa sổ.');
    }

    await requestBackend(backendUrl, '/api/session', {
        method: 'PUT',
        accessToken,
        expectJson: true,
        body: { sessionId, ttTargetIdc }
    });

    return { ok: true };
});

/**
 * Manual fallback for when the embedded login window is blocked by TikTok.
 * Values arrive from the renderer only because the operator pasted them there;
 * they are forwarded straight to the backend and never stored in the app.
 */
ipcMain.handle('tiktok:saveSession', async (_event, request) => {
    const backendUrl = getBackendUrl(request?.backendUrl);
    const accessToken = getAccessToken(request?.accessToken, backendUrl);

    const readField = (value, name, maxLength) => {
        const text = typeof value === 'string' ? value.trim() : '';
        if (text === '') {
            throw new Error(`Nhập ${name}.`);
        }
        if (text.length > maxLength || /[\s\u0000-\u001F\u007F]/.test(text)) {
            throw new Error(`${name} không hợp lệ.`);
        }
        return text;
    };

    const sessionId = readField(request?.sessionId, 'sessionid', 1024);
    const ttTargetIdc = readField(request?.ttTargetIdc, 'tt-target-idc', 64);

    await requestBackend(backendUrl, '/api/session', {
        method: 'PUT',
        accessToken,
        expectJson: true,
        body: { sessionId, ttTargetIdc }
    });

    return { ok: true };
});

function createWindow() {
    const window = new BrowserWindow({
        width: 900,
        height: 760,
        minWidth: 680,
        minHeight: 620,
        backgroundColor: '#0b0d12',
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });

    mainWindow = window;
    window.on('closed', () => {
        if (mainWindow === window) mainWindow = null;
    });

    const appPageUrl = pathToFileURL(path.join(__dirname, 'index.html')).href;
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, targetUrl) => {
        if (targetUrl !== appPageUrl) {
            event.preventDefault();
        }
    });
    window.loadURL(appPageUrl);
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    stopEchoStream();
    if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', stopEchoStream);
