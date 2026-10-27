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
const characterCount = document.querySelector('#character-count');
const accountBadge = document.querySelector('#account-badge');
const loginButton = document.querySelector('#login-button');
const liveStatus = document.querySelector('#live-status');

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
const bufferedEchoes = new Map();
let prewarmTimer = null;

function setResult(state, title, message) {
    result.dataset.state = state;
    resultIcon.textContent = state === 'success' ? '✓' : state === 'error' ? '!' : 'i';
    resultTitle.textContent = title;
    resultMessage.textContent = message;
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
        liveStatus.textContent = '● ĐANG LIVE';
    } else if (value === false) {
        liveStatus.className = 'badge badge-idle';
        liveStatus.textContent = 'OFFLINE';
    } else if (value === 'checking') {
        liveStatus.className = 'badge badge-idle';
        liveStatus.textContent = 'ĐANG KIỂM TRA…';
    } else {
        liveStatus.className = 'badge badge-idle';
        liveStatus.textContent = 'CHƯA KIỂM TRA';
    }
}

function describeError(error) {
    const raw = error && error.message ? error.message : 'Lỗi không xác định.';
    return raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
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
        setResult('success', 'Đã thấy bình luận trên LIVE', `Xuất hiện trong chat LIVE sau ${appeared} kể từ lúc gửi.`);
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
    setConnectionStatus('idle', 'CHƯA KIỂM TRA');
    setResult('idle', 'Đã thay đổi cấu hình', 'Kiểm tra backend trước khi gửi.');
    schedulePrewarm();
});
uniqueIdInput.addEventListener('change', () => {
    saveSettings();
    schedulePrewarm();
});
accessTokenInput.addEventListener('change', () => {
    setConnectionStatus('idle', 'CHƯA KIỂM TRA');
    setResult('idle', 'Đã thay đổi cấu hình', 'Kiểm tra backend trước khi gửi.');
    schedulePrewarm();
});

contentInput.addEventListener('input', () => {
    characterCount.textContent = `${contentInput.value.length} ký tự`;
});

contentInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    if (!sendButton.disabled) form.requestSubmit();
});

loginButton.addEventListener('click', async () => {
    if (!backendInput.value.trim()) {
        setAccountStatus('error', 'NHẬP BACKEND TRƯỚC');
        setResult('error', 'Chưa có backend', 'Nhập địa chỉ backend trước khi kết nối tài khoản TikTok.');
        return;
    }

    loginButton.disabled = true;
    loginButton.textContent = 'Đang đăng nhập…';
    setAccountStatus('idle', 'ĐANG ĐĂNG NHẬP…');
    setResult('idle', 'Đăng nhập TikTok', 'Đăng nhập trong cửa sổ mới, xong rồi đóng cửa sổ đó lại.');

    try {
        await window.commentApp.loginTikTok({
            backendUrl: backendInput.value,
            accessToken: accessTokenInput.value
        });
        setAccountStatus('ready', 'ĐÃ ĐĂNG NHẬP');
        setResult('success', 'Đã kết nối tài khoản TikTok',
            'Phiên đăng nhập đã được gửi lên backend và chỉ giữ trong RAM. Bình luận sẽ xuất hiện bằng tài khoản này.');
    } catch (error) {
        setAccountStatus('error', 'CHƯA KẾT NỐI');
        setResult('error', 'Chưa kết nối được tài khoản', describeError(error));
    } finally {
        loginButton.disabled = false;
        loginButton.textContent = 'Đăng nhập TikTok';
    }
});

checkButton.addEventListener('click', async () => {
    checkButton.disabled = true;
    checkButton.textContent = 'Đang kiểm tra…';
    setConnectionStatus('idle', 'ĐANG KIỂM TRA');

    try {
        const response = await window.commentApp.checkBackend({
            backendUrl: backendInput.value,
            accessToken: accessTokenInput.value
        });
        saveSettings();
        setConnectionStatus('ready', 'BACKEND SẴN SÀNG');
        if (response.sessionConfigured === true) {
            setAccountStatus('ready', 'ĐÃ ĐĂNG NHẬP');
        } else if (response.sessionConfigured === false) {
            setAccountStatus('idle', 'CHƯA ĐĂNG NHẬP');
        } else {
            setAccountStatus('idle', 'CHƯA KIỂM TRA');
        }
        setResult('success', 'Backend phản hồi', `HTTP ${response.status} · ${response.elapsedMs} ms đến /health.`);
        schedulePrewarm();
    } catch (error) {
        setConnectionStatus('error', 'KHÔNG KẾT NỐI');
        setResult('error', 'Không kiểm tra được backend', describeError(error));
    } finally {
        checkButton.disabled = false;
        checkButton.textContent = 'Kiểm tra';
    }
});

form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;

    sendButton.disabled = true;
    sendButtonLabel.textContent = 'Đang gửi…';
    // Echoes from a previous send must not overwrite this one's result.
    lastSend = null;

    try {
        const response = await window.commentApp.sendComment({
            backendUrl: backendInput.value,
            accessToken: accessTokenInput.value,
            uniqueId: uniqueIdInput.value,
            content: contentInput.value
        });
        saveSettings();
        setConnectionStatus('ready', 'BACKEND SẴN SÀNG');

        lastSend = {
            requestId: response.requestId,
            dryRun: response.dryRun
        };

        contentInput.value = '';
        characterCount.textContent = '0 ký tự';

        if (response.dryRun) {
            setResult('success', 'Backend đã nhận yêu cầu (chế độ thử)',
                `${response.elapsedMs} ms từ lúc gửi đến khi backend phản hồi. Chưa gửi gì lên TikTok.`);
            return;
        }

        const providerTiming = response.providerMs === null ? '' : ` · ${response.providerMs} ms provider`;
        const requestId = response.requestId ? ` · mã ${response.requestId}` : '';
        setResult('success', 'Đã gửi tới TikTok',
            `${response.elapsedMs} ms tới backend${providerTiming}. Đang chờ bình luận hiện trên LIVE…${requestId}`);

        if (response.requestId && bufferedEchoes.has(response.requestId)) {
            const echo = bufferedEchoes.get(response.requestId);
            bufferedEchoes.delete(response.requestId);
            applyEcho(echo);
        }
    } catch (error) {
        setConnectionStatus('error', 'KIỂM TRA LẠI');
        setResult('error', 'Không gửi được', `${describeError(error)} App không tự thử lại.`);
    } finally {
        sendButton.disabled = false;
        sendButtonLabel.textContent = 'Gửi bình luận';
    }
});
