const backendInput = document.querySelector('#backend-url');
const uniqueIdInput = document.querySelector('#unique-id');
const checkButton = document.querySelector('#check-button');
const delayOptions = document.querySelector('#send-delay-options');
const connectionBadge = document.querySelector('#connection-badge');
const accountBadge = document.querySelector('#account-badge');
const loginButton = document.querySelector('#login-button');
const liveStatus = document.querySelector('#live-status');
const manualSessionIdInput = document.querySelector('#manual-session-id');
const manualIdcInput = document.querySelector('#manual-idc');
const saveSessionButton = document.querySelector('#save-session-button');

localStorage.removeItem('backendUrl');
localStorage.removeItem('uniqueId');

let prewarmTimer = null;
let delaySyncQueue = Promise.resolve();
let delaySyncVersion = 0;

function setConnectionStatus(state, label) {
    connectionBadge.className = `badge ${state === 'ready' ? 'badge-ready' : state === 'error' ? 'badge-error' : 'badge-idle'}`;
    connectionBadge.textContent = label;
}

function setAccountStatus(state, label) {
    accountBadge.className = `badge ${state === 'ready' ? 'badge-ready' : state === 'error' ? 'badge-error' : 'badge-idle'}`;
    accountBadge.textContent = label;
}

function setLiveStatus(value) {
    if (value === true) {
        liveStatus.className = 'badge badge-ready';
        liveStatus.textContent = 'Đang live';
    } else if (value === false) {
        liveStatus.className = 'badge badge-idle';
        liveStatus.textContent = 'Chưa live';
    } else if (value === 'checking') {
        liveStatus.className = 'badge badge-idle';
        liveStatus.textContent = 'Đang kiểm tra…';
    } else {
        liveStatus.className = 'badge badge-idle';
        liveStatus.textContent = 'Chưa kiểm tra';
    }
}

function describeError(error) {
    const raw = error && error.message ? error.message : 'Lỗi không xác định.';
    return raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

function selectedDelayMs() {
    const delayMs = Number(delayOptions.querySelector('input[name="send-delay"]:checked')?.value);
    return [2_000, 3_000, 5_000].includes(delayMs) ? delayMs : 2_000;
}

function syncSendDelay() {
    const backendUrl = backendInput.value.trim();
    if (!backendUrl) return;

    const version = ++delaySyncVersion;
    const delayMs = selectedDelayMs();
    delaySyncQueue = delaySyncQueue.catch(() => undefined).then(async () => {
        try {
            const response = await window.commentApp.setSendDelay({ backendUrl, delayMs });
            if (version === delaySyncVersion && response.delayMs !== delayMs) {
                setConnectionStatus('error', 'Độ trễ chưa lưu');
            }
        } catch {
            if (version === delaySyncVersion) setConnectionStatus('error', 'Không áp dụng được');
        }
    });
}

function schedulePrewarm() {
    if (prewarmTimer !== null) clearTimeout(prewarmTimer);
    prewarmTimer = setTimeout(() => {
        prewarmTimer = null;

        const backendUrl = backendInput.value.trim();
        const uniqueId = uniqueIdInput.value.trim().replace(/^@/, '');
        if (!backendUrl || !uniqueId) return;

        setLiveStatus('checking');
        window.commentApp.prewarm({
            backendUrl,
            uniqueId
        }).then((response) => {
            setLiveStatus(response && typeof response.isLive === 'boolean' ? response.isLive : null);
        }).catch(() => {
            // Prewarm is optional; leave the channel status unverified on failure.
            setLiveStatus(null);
        });
    }, 400);
}

uniqueIdInput.addEventListener('change', () => {
    schedulePrewarm();
});
// Prewarm while typing so the LIVE status can be checked before the user finishes.
uniqueIdInput.addEventListener('input', () => {
    if (uniqueIdInput.value.trim().replace(/^@/, '').length >= 2) schedulePrewarm();
});
delayOptions.addEventListener('change', syncSendDelay);

loginButton.addEventListener('click', async () => {
    if (!backendInput.value.trim()) {
        setAccountStatus('error', 'Backend chưa sẵn sàng');
        return;
    }

    loginButton.disabled = true;
    loginButton.textContent = 'Đang đăng nhập…';
    setAccountStatus('idle', 'Đang đăng nhập…');

    try {
        await window.commentApp.loginTikTok({
            backendUrl: backendInput.value
        });
        setAccountStatus('ready', 'Đã đăng nhập');
        schedulePrewarm();
    } catch (error) {
        setAccountStatus('error', 'Chưa kết nối');
        if (/backend/i.test(describeError(error))) setConnectionStatus('error', 'Backend lỗi');
    } finally {
        loginButton.disabled = false;
        loginButton.textContent = 'Đăng nhập TikTok';
    }
});

saveSessionButton.addEventListener('click', async () => {
    if (!backendInput.value.trim()) {
        setAccountStatus('error', 'Backend chưa sẵn sàng');
        return;
    }

    saveSessionButton.disabled = true;
    saveSessionButton.textContent = 'Đang lưu…';
    setAccountStatus('idle', 'Đang lưu phiên…');

    try {
        await window.commentApp.saveSession({
            backendUrl: backendInput.value,
            sessionId: manualSessionIdInput.value,
            ttTargetIdc: manualIdcInput.value
        });
        // Do not keep the secret in the DOM once the backend has it.
        manualSessionIdInput.value = '';
        manualIdcInput.value = '';
        setAccountStatus('ready', 'Đã đăng nhập');
        schedulePrewarm();
    } catch (error) {
        setAccountStatus('error', 'Chưa kết nối');
        if (/backend/i.test(describeError(error))) setConnectionStatus('error', 'Backend lỗi');
    } finally {
        saveSessionButton.disabled = false;
        saveSessionButton.textContent = 'Lưu phiên';
    }
});

checkButton.addEventListener('click', async () => {
    checkButton.disabled = true;
    checkButton.textContent = 'Đang kiểm tra…';
    setConnectionStatus('idle', 'Đang kiểm tra');

    try {
        const response = await window.commentApp.checkBackend({
            backendUrl: backendInput.value
        });
        setConnectionStatus('ready', 'Backend sẵn sàng');
        if (response.sessionConfigured === true) {
            setAccountStatus('ready', 'Đã đăng nhập');
        } else if (response.sessionConfigured === false) {
            setAccountStatus('idle', 'Chưa đăng nhập');
        } else {
            setAccountStatus('idle', 'Chưa kiểm tra');
        }
        schedulePrewarm();
    } catch (error) {
        // A 401 means the backend answered and refused the token; saying "không
        // kết nối" there sends the operator looking at the wrong thing.
        if (/\b401\b/.test(describeError(error))) {
            setConnectionStatus('error', 'Backend lỗi');
        } else {
            setConnectionStatus('error', 'Không kết nối');
        }
    } finally {
        checkButton.disabled = false;
        checkButton.textContent = 'Kiểm tra';
    }
});

window.commentApp.getBackendConfig().then((config) => {
    if (!config || !config.backendUrl || config.error) {
        setConnectionStatus('error', 'Không khởi động được');
        return;
    }

    backendInput.value = config.backendUrl;
    checkButton.disabled = false;
    loginButton.disabled = false;
    saveSessionButton.disabled = false;
    syncSendDelay();
    checkButton.click();
}).catch(() => {
    setConnectionStatus('error', 'Không khởi động được');
});
