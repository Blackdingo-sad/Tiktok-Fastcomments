const { app, BrowserWindow, ipcMain, session: electronSession, utilityProcess } = require('electron');
const { randomBytes } = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { pathToFileURL } = require('node:url');

const REQUEST_TIMEOUT_MS = 10000;
const STREAM_RECONNECT_MS = 1500;
const STREAM_RETRY_AFTER_ERROR_MS = 5000;
const BACKEND_START_TIMEOUT_MS = 10000;
const BACKEND_HOST = '127.0.0.1';

const httpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 4 });
const httpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 4 });

let mainWindow = null;
let loginWindow = null;
let localBackendUrl = null;
let localBackendProcess = null;
let localBackendExitCode = null;
let backendStartupError = null;
// Per-run auth for requests between this app and its bundled loopback backend.
const localAccessToken = randomBytes(32).toString('hex');

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

function getAccessToken(backendUrl) {
    if (localBackendUrl === null
        || backendUrl.origin !== localBackendUrl.origin
        || backendUrl.pathname !== localBackendUrl.pathname) {
        throw new Error('Không đúng backend cục bộ của ứng dụng.');
    }
    return localAccessToken;
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

        const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
        request.setTimeout(timeoutMs, () => {
            const timeoutError = new Error('request_timeout');
            timeoutError.code = 'APP_TIMEOUT';
            timeoutError.timeoutMs = timeoutMs;
            request.destroy(timeoutError);
        });

        request.on('error', (error) => {
            if (error?.code === 'APP_TIMEOUT') {
                const seconds = Math.round(error.timeoutMs / 1000);
                reject(new Error(`Quá thời gian chờ ${seconds} giây; backend có thể đã nhận yêu cầu. Kiểm tra trạng thái trước khi thử lại.`));
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

function findAvailablePort() {
    const probe = net.createServer();
    return new Promise((resolve, reject) => {
        probe.once('error', reject);
        probe.listen(0, BACKEND_HOST, () => {
            const address = probe.address();
            probe.close((error) => error
                ? reject(error)
                : resolve(typeof address === 'object' && address !== null ? address.port : null));
        });
    });
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startLocalBackend() {
    const port = await findAvailablePort();
    if (typeof port !== 'number') throw new Error('Không tìm được cổng chạy backend cục bộ.');

    localBackendUrl = new URL(`http://${BACKEND_HOST}:${port}`);
    const backendScript = app.isPackaged
        ? path.join(process.resourcesPath, 'app.asar.unpacked', 'backend.bundle.cjs')
        : path.join(__dirname, 'backend.bundle.cjs');
    const backendEnv = {
        ...process.env,
        APP_TOKEN: localAccessToken,
        HOST: BACKEND_HOST,
        PORT: String(port),
        SEND_PROVIDER: 'browser',
        SEND_DRY_RUN: '0',
        EULER_API_KEY: '',
        TIKTOK_SESSION_ID: '',
        TIKTOK_TT_TARGET_IDC: '',
        BROWSER_HEADLESS: '0'
    };

    let processError = null;
    localBackendProcess = utilityProcess.fork(backendScript, [], {
        cwd: path.dirname(backendScript),
        env: backendEnv,
        stdio: 'ignore',
        serviceName: 'LIVE Comment Desk Backend'
    });
    localBackendProcess.once('error', () => { processError = new Error('Backend utility process failed.'); });
    localBackendProcess.once('exit', (code) => { localBackendExitCode = code; });

    const deadline = Date.now() + BACKEND_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (processError !== null) throw processError;
        if (localBackendExitCode !== null) {
            throw new Error(`Backend process exited with code ${localBackendExitCode}.`);
        }
        try {
            await requestBackend(localBackendUrl, '/api/session', {
                accessToken: localAccessToken,
                expectJson: true
            });
            return;
        } catch {
            await delay(100);
        }
    }
    throw new Error('Hết thời gian khởi động backend cục bộ.');
}

function stopLocalBackend() {
    const child = localBackendProcess;
    localBackendProcess = null;
    if (child !== null) child.kill();
}

ipcMain.handle('backend:check', async (_event, backendUrlValue) => {
    const backendUrl = getBackendUrl(backendUrlValue?.backendUrl);
    const accessToken = getAccessToken(backendUrl);
    const startedAt = performance.now();
    const healthPromise = requestBackend(backendUrl, '/health', { accessToken });
    const sessionPromise = requestBackend(backendUrl, '/api/session', { accessToken, expectJson: true })
        .then(({ data }) => (data && data.configured === true ? true : false))
        .catch(() => null);
    const health = await healthPromise;

    return {
        ok: true,
        status: health.status,
        elapsedMs: Math.round(performance.now() - startedAt),
        // true = đã đăng nhập, false = chưa, null = backend cũ / chưa biết.
        sessionConfigured: await sessionPromise
    };
});

ipcMain.handle('backend:local-config', () => ({
    backendUrl: localBackendUrl?.href ?? '',
    error: backendStartupError
}));

ipcMain.handle('comment:prewarm', async (_event, request) => {
    const backendUrl = getBackendUrl(request?.backendUrl);
    const accessToken = getAccessToken(backendUrl);
    const uniqueId = getUniqueId(request?.uniqueId);

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

ipcMain.handle('tiktok:set-send-delay', async (_event, request) => {
    const backendUrl = getBackendUrl(request?.backendUrl);
    const accessToken = getAccessToken(backendUrl);
    const delayMs = request?.delayMs;
    if (![2_000, 3_000, 5_000].includes(delayMs)) {
        throw new Error('Độ trễ phải là 2, 3 hoặc 5 giây.');
    }

    const { data } = await requestBackend(backendUrl, '/api/settings/send-delay', {
        method: 'POST',
        accessToken,
        expectJson: true,
        body: { delayMs }
    });
    if (!data || data.ok !== true || data.delayMs !== delayMs) {
        throw new Error('Backend chưa áp dụng được độ trễ cho cửa sổ TikTok.');
    }
    return { ok: true, delayMs };
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

const TIKTOK_LOGIN_POPUP_DOMAINS = [
    'tiktok.com',
    'facebook.com',
    'google.com',
    'line.me',
    'kakao.com',
    'apple.com'
];

function isAllowedTikTokLoginUrl(targetUrl) {
    if (targetUrl === 'about:blank') return true;

    let url;
    try {
        url = new URL(targetUrl);
    } catch {
        return false;
    }

    if (url.protocol !== 'https:') return false;
    const hostname = url.hostname.toLowerCase();
    return TIKTOK_LOGIN_POPUP_DOMAINS.some((domain) => (
        hostname === domain || hostname.endsWith(`.${domain}`)
    ));
}

function configureTikTokLoginPopups(window) {
    const contents = window.webContents;
    contents.setWindowOpenHandler(({ url }) => {
        if (!isAllowedTikTokLoginUrl(url)) return { action: 'deny' };

        return {
            action: 'allow',
            overrideBrowserWindowOptions: {
                parent: window,
                autoHideMenuBar: true,
                webPreferences: {
                    session: contents.session,
                    contextIsolation: true,
                    nodeIntegration: false,
                    sandbox: true
                }
            }
        };
    });

    const guardNavigation = (event, details, _isInPlace, legacyIsMainFrame = true) => {
        const url = typeof details === 'string' ? details : details?.url;
        const isMainFrame = typeof details === 'string'
            ? legacyIsMainFrame
            : details?.isMainFrame !== false;
        if (isMainFrame && !isAllowedTikTokLoginUrl(url)) event.preventDefault();
    };
    contents.on('will-navigate', guardNavigation);
    contents.on('will-redirect', guardNavigation);
    contents.on('did-create-window', (childWindow) => configureTikTokLoginPopups(childWindow));
}

ipcMain.handle('tiktok:login', async (_event, request) => {
    const backendUrl = getBackendUrl(request?.backendUrl);
    const accessToken = getAccessToken(backendUrl);

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

    configureTikTokLoginPopups(window);
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
    const accessToken = getAccessToken(backendUrl);

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

app.whenReady().then(async () => {
    try {
        await startLocalBackend();
    } catch (error) {
        console.error('Local backend startup failed:', error);
        backendStartupError = 'Không thể khởi động backend cục bộ. Hãy đóng rồi mở lại ứng dụng.';
        stopLocalBackend();
        localBackendUrl = null;
    }
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
    stopLocalBackend();
});
