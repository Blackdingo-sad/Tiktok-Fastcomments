const backendInput = document.querySelector('#backend-url');
const accessTokenInput = document.querySelector('#access-token');
const uniqueIdInput = document.querySelector('#unique-id');
const contentInput = document.querySelector('#comment-content');
const checkButton = document.querySelector('#check-button');
const sendButton = document.querySelector('#send-button');
const sendButtonLabel = document.querySelector('#send-button-label');
const form = document.querySelector('#comment-form');
const result = document.querySelector('#result');
const resultIcon = document.querySelector('#result-icon');
const resultTitle = document.querySelector('#result-title');
const resultMessage = document.querySelector('#result-message');
const connectionBadge = document.querySelector('#connection-badge');
const resultStages = document.querySelector('#result-stages');
const characterCount = document.querySelector('#character-count');
const accountBadge = document.querySelector('#account-badge');
const loginButton = document.querySelector('#login-button');
const liveStatus = document.querySelector('#live-status');
const manualSessionIdInput = document.querySelector('#manual-session-id');
const manualIdcInput = document.querySelector('#manual-idc');
const saveSessionButton = document.querySelector('#save-session-button');

const savedBackendUrl = localStorage.getItem('backendUrl');
const savedUniqueId = localStorage.getItem('uniqueId');
if (savedBackendUrl) backendInput.value = savedBackendUrl;
if (savedUniqueId) uniqueIdInput.value = savedUniqueId;

const echoReasonLabels = {
    timeout: 'hết thời gian chờ bình luận hiện ra',
    echo_unavailable: 'không mở được kênh theo dõi',
    echo_disabled: 'đã tắt xác nhận trên LIVE',
    connection_closed: 'mất kết nối theo dõi',
    send_failed: 'lần gửi không thành công',
    dry_run: 'chế độ thử, chưa gửi lên TikTok'
};

let lastSend = null;
// Wall-clock moment the send was requested (Enter keydown or submit), used as
// stage 0 of the per-stage latency breakdown.
let sendRequestedAtMs = null;
const bufferedEchoes = new Map();
let prewarmTimer = null;

function setResult(state, title, message, stages = null) {
    result.dataset.state = state;
    resultIcon.textContent = state === 'success' ? '✓' : state === 'error' ? '!' : 'i';
    resultTitle.textContent = title;
    resultMessage.textContent = message;

    resultStages.replaceChildren();
    if (Array.isArray(stages) && stages.length > 0) {
        for (const stage of stages) {
            const term = document.createElement('dt');
            term.textContent = stage.label;
            const value = document.createElement('dd');
            value.textContent = stage.value;
            resultStages.append(term, value);
        }
        resultStages.hidden = false;
    } else {
        resultStages.hidden = true;
    }
}

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

/**
 * Per-stage latency of one send, in wall-clock milliseconds:
 *   keydown → response (whole path), renderer → main (IPC), network
 *   (response − backend), backend handler, provider acceptance.
 * Returned as rows so the result panel can print each stage as a figure.
 */
function describeStages(response, requestedAtMs) {
    const stages = [];
    if (typeof response.receivedAtMs === 'number' && requestedAtMs !== null) {
        stages.push({ label: 'Gõ đến phản hồi', value: `${Math.max(0, response.receivedAtMs - requestedAtMs)} ms` });
    }
    if (Number.isFinite(response.ipcMs)) {
        stages.push({ label: 'Renderer đến main', value: `${response.ipcMs} ms` });
    }
    if (Number.isFinite(response.backendMs)) {
        stages.push({ label: 'Backend xử lý', value: `${response.backendMs} ms` });
        if (Number.isFinite(response.responseMs)) {
            stages.push({ label: 'Mạng', value: `${Math.max(0, response.responseMs - response.backendMs)} ms` });
        }
    }
    if (Number.isFinite(response.providerMs)) {
        stages.push({ label: 'Provider nhận', value: `${response.providerMs} ms` });
    }
    if (stages.length === 0) {
        stages.push({ label: 'Tổng', value: `${response.elapsedMs} ms` });
    }
    return stages;
}

function saveSettings() {
    localStorage.setItem('backendUrl', backendInput.value.trim());
    localStorage.setItem('uniqueId', uniqueIdInput.value.trim().replace(/^@/, ''));
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
            accessToken: accessTokenInput.value,
            uniqueId
        }).then((response) => {
            setLiveStatus(response && typeof response.isLive === 'boolean' ? response.isLive : null);
        }).catch(() => {
            // Prewarm is an optimization; failures surface on the real send.
            setLiveStatus(null);
        });
    }, 400);
}

function applyEcho(event) {
    if (!lastSend || lastSend.dryRun) return;
    if (!event || event.requestId !== lastSend.requestId) return;

    if (event.confirmed === true) {
        const appeared = event.appearedMs === null || event.appearedMs === undefined
            ? 'không rõ'
            : `${event.appearedMs} ms`;
        // Keep the measured keydown→response stage visible, because this echo
        // message replaces the send result above.
        const stages = [{ label: 'Hiện trên LIVE', value: `${appeared}` }];
        if (lastSend.requestedAtMs !== null && typeof lastSend.receivedAtMs === 'number') {
            stages.unshift({
                label: 'Gõ đến phản hồi',
                value: `${Math.max(0, lastSend.receivedAtMs - lastSend.requestedAtMs)} ms`
            });
        }
        setResult('success', 'Đã thấy bình luận trên LIVE',
            'TikTok đã hiện bình luận này trong chat LIVE.', stages);
        return;
    }

    const reason = echoReasonLabels[event.echoReason] || 'chưa có tín hiệu xác nhận';
    setResult('idle', 'Chưa xác nhận trên LIVE', `Chưa thấy bình luận hiện ra (${reason}). Backend vẫn đã gửi.`);
}

window.commentApp.onEcho((event) => {
    if (!event || typeof event.requestId !== 'string') return;

    if (lastSend && lastSend.requestId === event.requestId) {
        applyEcho(event);
        return;
    }

    bufferedEchoes.set(event.requestId, event);
    if (bufferedEchoes.size > 20) {
        const oldest = bufferedEchoes.keys().next().value;
        if (oldest !== undefined) bufferedEchoes.delete(oldest);
    }
});

backendInput.addEventListener('change', () => {
    saveSettings();
    setConnectionStatus('idle', 'Chưa kiểm tra');
    setResult('idle', 'Đã thay đổi cấu hình', 'Kiểm tra backend trước khi gửi.');
    schedulePrewarm();
});
uniqueIdInput.addEventListener('change', () => {
    saveSettings();
    schedulePrewarm();
});
// Prewarm while typing, not only on blur: by the time the user finishes the
// comment the room lookup is already done, so the first send does not wait on
// it. One character is skipped because TikTok handles are never that short.
uniqueIdInput.addEventListener('input', () => {
    if (uniqueIdInput.value.trim().replace(/^@/, '').length >= 2) schedulePrewarm();
});
accessTokenInput.addEventListener('change', () => {
    setConnectionStatus('idle', 'Chưa kiểm tra');
    setResult('idle', 'Đã thay đổi cấu hình', 'Kiểm tra backend trước khi gửi.');
    schedulePrewarm();
});

contentInput.addEventListener('input', () => {
    characterCount.textContent = `${contentInput.value.length} ký tự`;
});

contentInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    if (sendButton.disabled) {
        // Nothing will be sent; drop the mark so a later send cannot inherit it.
        sendRequestedAtMs = null;
        return;
    }
    sendRequestedAtMs = Date.now();
    form.requestSubmit();
});

loginButton.addEventListener('click', async () => {
    if (!backendInput.value.trim()) {
        setAccountStatus('error', 'Nhập backend trước');
        setResult('error', 'Chưa có backend', 'Nhập địa chỉ backend trước khi kết nối tài khoản TikTok.');
        return;
    }
    if (!accessTokenInput.value.trim()) {
        setAccountStatus('error', 'Cần token');
        setResult('error', 'Thiếu token backend', 'Nhập APP_TOKEN trong server/.env rồi kiểm tra lại backend trước khi kết nối tài khoản.');
        return;
    }

    loginButton.disabled = true;
    loginButton.textContent = 'Đang đăng nhập…';
    setAccountStatus('idle', 'Đang đăng nhập…');
    setResult('idle', 'Đăng nhập TikTok', 'Đăng nhập trong cửa sổ mới, xong rồi đóng cửa sổ đó lại.');

    try {
        await window.commentApp.loginTikTok({
            backendUrl: backendInput.value,
            accessToken: accessTokenInput.value
        });
        setAccountStatus('ready', 'Đã đăng nhập');
        setResult('success', 'Đã kết nối tài khoản TikTok',
            'Phiên đăng nhập đã được gửi lên backend và chỉ giữ trong RAM. Bình luận sẽ xuất hiện bằng tài khoản này.');
        // Any prewarm sent before login had no session to open Chrome with, so
        // repeat it now: the first comment then finds a warm window.
        schedulePrewarm();
    } catch (error) {
        setAccountStatus('error', 'Chưa kết nối');
        setResult('error', 'Chưa kết nối được tài khoản', describeError(error));
    } finally {
        loginButton.disabled = false;
        loginButton.textContent = 'Đăng nhập TikTok';
    }
});

saveSessionButton.addEventListener('click', async () => {
    if (!backendInput.value.trim()) {
        setAccountStatus('error', 'Nhập backend trước');
        setResult('error', 'Chưa có backend', 'Nhập địa chỉ backend trước khi lưu phiên TikTok.');
        return;
    }
    if (!accessTokenInput.value.trim()) {
        setAccountStatus('error', 'Cần token');
        setResult('error', 'Thiếu token backend', 'Nhập APP_TOKEN trong server/.env rồi kiểm tra lại backend trước khi lưu phiên.');
        return;
    }

    saveSessionButton.disabled = true;
    saveSessionButton.textContent = 'Đang lưu…';
    setAccountStatus('idle', 'Đang lưu phiên…');

    try {
        await window.commentApp.saveSession({
            backendUrl: backendInput.value,
            accessToken: accessTokenInput.value,
            sessionId: manualSessionIdInput.value,
            ttTargetIdc: manualIdcInput.value
        });
        // Do not keep the secret in the DOM once the backend has it.
        manualSessionIdInput.value = '';
        manualIdcInput.value = '';
        setAccountStatus('ready', 'Đã đăng nhập');
        setResult('success', 'Đã lưu phiên TikTok',
            'Backend đã nhận phiên và chỉ giữ trong RAM. Bình luận sẽ xuất hiện bằng tài khoản này.');
        // The handle may already be filled in; warm Chrome with this session.
        schedulePrewarm();
    } catch (error) {
        setAccountStatus('error', 'Chưa kết nối');
        setResult('error', 'Chưa lưu được phiên', describeError(error));
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
            backendUrl: backendInput.value,
            accessToken: accessTokenInput.value
        });
        saveSettings();
        setConnectionStatus('ready', 'Backend sẵn sàng');
        if (response.sessionConfigured === true) {
            setAccountStatus('ready', 'Đã đăng nhập');
        } else if (response.sessionConfigured === false) {
            setAccountStatus('idle', 'Chưa đăng nhập');
        } else {
            setAccountStatus('idle', 'Chưa kiểm tra');
        }
        setResult('success', 'Backend phản hồi', `HTTP ${response.status}, ${response.elapsedMs} ms đến /health.`);
        schedulePrewarm();
    } catch (error) {
        // A 401 means the backend answered and refused the token; saying "không
        // kết nối" there sends the operator looking at the wrong thing.
        if (/\b401\b/.test(describeError(error))) {
            setConnectionStatus('error', 'Sai token');
            setResult('error', 'Token không khớp backend',
                'Backend đang chạy nhưng từ chối token này. Chép lại đúng APP_TOKEN trong server/.env của backend đang chạy.');
        } else {
            setConnectionStatus('error', 'Không kết nối');
            setResult('error', 'Không kiểm tra được backend', describeError(error));
        }
    } finally {
        checkButton.disabled = false;
        checkButton.textContent = 'Kiểm tra';
    }
});

form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;

    // Stage 0: Enter keydown when the fast path was used, otherwise submit.
    const requestedAtMs = sendRequestedAtMs ?? Date.now();
    sendRequestedAtMs = null;

    sendButton.disabled = true;
    sendButtonLabel.textContent = 'Đang gửi…';
    // Echoes from a previous send must not overwrite this one's result.
    lastSend = null;

    try {
        const response = await window.commentApp.sendComment({
            backendUrl: backendInput.value,
            accessToken: accessTokenInput.value,
            uniqueId: uniqueIdInput.value,
            content: contentInput.value,
            clientSentAtMs: requestedAtMs
        });
        saveSettings();
        setConnectionStatus('ready', 'Backend sẵn sàng');

        lastSend = {
            requestId: response.requestId,
            dryRun: response.dryRun,
            requestedAtMs,
            receivedAtMs: response.receivedAtMs
        };

        contentInput.value = '';
        characterCount.textContent = '0 ký tự';

        const stages = describeStages(response, requestedAtMs);
        if (response.requestId) {
            stages.push({ label: 'Mã yêu cầu', value: String(response.requestId) });
        }

        if (response.dryRun) {
            setResult('success', 'Backend đã nhận yêu cầu (chế độ thử)',
                'Chưa gửi gì lên TikTok.', stages);
            return;
        }

        setResult('success', 'Đã gửi tới TikTok',
            'Đang chờ bình luận hiện trên LIVE.', stages);

        if (response.requestId && bufferedEchoes.has(response.requestId)) {
            const echo = bufferedEchoes.get(response.requestId);
            bufferedEchoes.delete(response.requestId);
            applyEcho(echo);
        }
    } catch (error) {
        setConnectionStatus('error', 'Kiểm tra lại');
        if (/\b401\b/.test(describeError(error))) {
            setResult('error', 'Token không khớp backend',
                'Backend từ chối token, nên bình luận chưa được gửi. Chép lại đúng APP_TOKEN trong server/.env.');
            return;
        }
        setResult('error', 'Không gửi được', `${describeError(error)} App không tự thử lại.`);
    } finally {
        sendButton.disabled = false;
        sendButtonLabel.textContent = 'Gửi bình luận';
    }
});
