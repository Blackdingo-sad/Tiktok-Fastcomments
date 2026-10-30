package com.blackdingo.livecommentdesk;

import android.accessibilityservice.AccessibilityService;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.SystemClock;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Deque;
import java.util.List;
import java.util.Locale;

/**
 * Reads the TikTok window through Android accessibility, drops the prepared comment into the LIVE
 * chat box and submits it once. It never loops and never retries: one tap does one attempt, and the
 * attempt is only reported as sent when the chat box is empty again afterwards.
 */
public class SendAccessibilityService extends AccessibilityService {

    static final List<String> TIKTOK_PACKAGES = Arrays.asList(
            "com.zhiliaoapp.musically",
            "com.ss.android.ugc.trill",
            "com.ss.android.ugc.aweme");

    private static final List<String> SEND_LABELS = Arrays.asList("send", "gửi", "gui", "gửi đi", "đăng");

    private static final long FOREGROUND_TIMEOUT_MS = 4_000;
    private static final long FOREGROUND_POLL_MS = 100;
    private static final long CONFIRM_TIMEOUT_MS = 1_200;
    private static final long CONFIRM_POLL_MS = 40;
    private static final int NODE_SCAN_BUDGET = 4_000;
    private static final int NODE_MAX_DEPTH = 40;

    private static volatile SendAccessibilityService instance;

    private HandlerThread worker;
    private Handler workerHandler;
    private volatile boolean inFlight;

    static SendAccessibilityService get() {
        return instance;
    }

    /** One attempt's outcome and its stage timings, all in milliseconds. */
    static final class Result {
        boolean ok;
        String reason;
        String submitPath = "none";
        long tapToTiktok;
        long tiktokToInput;
        long inputToText;
        long textToSubmit;
        long submitToConfirm;

        long total() {
            return tapToTiktok + tiktokToInput + inputToText + textToSubmit + submitToConfirm;
        }
    }

    interface Callback {
        void onResult(Result result);
    }

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        instance = this;
        worker = new HandlerThread("send-worker");
        worker.start();
        workerHandler = new Handler(worker.getLooper());
    }

    @Override
    public void onDestroy() {
        instance = null;
        if (worker != null) {
            worker.quitSafely();
            worker = null;
            workerHandler = null;
        }
        super.onDestroy();
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        // Nothing is done from events: every send is triggered by the operator tapping the button.
    }

    @Override
    public void onInterrupt() {
        // No long-running feedback to interrupt.
    }

    /** Starts one send attempt. Returns false when another attempt is already running. */
    boolean sendComment(String comment, Callback callback) {
        if (inFlight) return false;
        Handler handler = workerHandler;
        if (handler == null) return false;
        inFlight = true;
        handler.post(() -> {
            Result result;
            try {
                result = attemptSend(comment);
            } catch (RuntimeException error) {
                result = new Result();
                result.reason = "send_failed: " + error.getClass().getSimpleName();
            } finally {
                inFlight = false;
            }
            callback.onResult(result);
        });
        return true;
    }

    private Result attemptSend(String comment) {
        Result result = new Result();
        long t0 = SystemClock.elapsedRealtime();

        if (!bringTikTokToFront()) {
            result.reason = "tiktok_not_foreground";
            return result;
        }
        long t1 = SystemClock.elapsedRealtime();

        AccessibilityNodeInfo root = currentRoot();
        AccessibilityNodeInfo input = findChatInput(root);
        if (input == null) {
            result.reason = "chat_input_not_found";
            return result;
        }
        long t2 = SystemClock.elapsedRealtime();

        String hintKey = hintKeyOf(input);
        input.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
        if (!setText(input, singleLine(comment))) {
            result.reason = "set_text_refused";
            return result;
        }
        long t3 = SystemClock.elapsedRealtime();

        String submitPath = submit(root, input);
        if (submitPath == null) {
            result.reason = "submit_control_not_found";
            return result;
        }
        result.submitPath = submitPath;
        long t4 = SystemClock.elapsedRealtime();

        boolean cleared = waitForInputToClear(hintKey);
        long t5 = SystemClock.elapsedRealtime();

        result.tapToTiktok = t1 - t0;
        result.tiktokToInput = t2 - t1;
        result.inputToText = t3 - t2;
        result.textToSubmit = t4 - t3;
        result.submitToConfirm = t5 - t4;
        result.ok = cleared;
        if (!cleared) result.reason = "send_unconfirmed";
        return result;
    }

    private boolean bringTikTokToFront() {
        if (isTikTokForeground()) return true;
        String packageName = installedTikTokPackage();
        if (packageName == null) return false;
        Intent launch = getPackageManager().getLaunchIntentForPackage(packageName);
        if (launch == null) return false;
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            startActivity(launch);
        } catch (RuntimeException error) {
            return false;
        }
        long deadline = SystemClock.elapsedRealtime() + FOREGROUND_TIMEOUT_MS;
        while (SystemClock.elapsedRealtime() < deadline) {
            if (isTikTokForeground()) return true;
            SystemClock.sleep(FOREGROUND_POLL_MS);
        }
        return false;
    }

    /** Returns the first known TikTok package installed on this device, or null. */
    static String installedTikTokPackage(android.content.Context context) {
        for (String candidate : TIKTOK_PACKAGES) {
            try {
                context.getPackageManager().getPackageInfo(candidate, 0);
                return candidate;
            } catch (Exception ignored) {
                // Not installed: try the next known package name.
            }
        }
        return null;
    }

    private String installedTikTokPackage() {
        return installedTikTokPackage(this);
    }

    private boolean isTikTokForeground() {
        String packageName = foregroundPackage();
        return packageName != null && TIKTOK_PACKAGES.contains(packageName);
    }

    private String foregroundPackage() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root != null && root.getPackageName() != null) {
            return root.getPackageName().toString();
        }
        List<android.view.accessibility.AccessibilityWindowInfo> windows = getWindows();
        for (android.view.accessibility.AccessibilityWindowInfo window : windows) {
            if (window.getType() != android.view.accessibility.AccessibilityWindowInfo.TYPE_APPLICATION) continue;
            AccessibilityNodeInfo node = window.getRoot();
            if (node != null && node.getPackageName() != null) return node.getPackageName().toString();
        }
        return null;
    }

    private AccessibilityNodeInfo currentRoot() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root != null) return root;
        List<android.view.accessibility.AccessibilityWindowInfo> windows = getWindows();
        for (android.view.accessibility.AccessibilityWindowInfo window : windows) {
            if (window.getType() != android.view.accessibility.AccessibilityWindowInfo.TYPE_APPLICATION) continue;
            AccessibilityNodeInfo node = window.getRoot();
            if (node != null) return node;
        }
        return null;
    }

    private static boolean isChatHint(CharSequence hint) {
        if (hint == null) return false;
        String value = hint.toString().toLowerCase(Locale.ROOT);
        return value.contains("comment") || value.contains("bình luận") || value.contains("binh luan")
                || value.contains("chat") || value.contains("trò chuyện");
    }

    /** Prefers an editable node whose hint looks like a chat box, otherwise the last editable node. */
    private AccessibilityNodeInfo findChatInput(AccessibilityNodeInfo root) {
        if (root == null) return null;
        List<AccessibilityNodeInfo> editables = new ArrayList<>();
        Deque<AccessibilityNodeInfo> queue = new ArrayDeque<>();
        queue.add(root);
        int visited = 0;
        while (!queue.isEmpty() && visited < NODE_SCAN_BUDGET) {
            AccessibilityNodeInfo node = queue.poll();
            visited++;
            if (node.isEditable()) editables.add(node);
            for (int index = 0; index < node.getChildCount(); index++) {
                AccessibilityNodeInfo child = node.getChild(index);
                if (child != null) queue.add(child);
            }
        }
        AccessibilityNodeInfo fallback = null;
        for (AccessibilityNodeInfo node : editables) {
            if (isChatHint(node.getHintText()) || isChatHint(node.getContentDescription())) return node;
            fallback = node;
        }
        return fallback;
    }

    private static String hintKeyOf(AccessibilityNodeInfo node) {
        CharSequence hint = node.getHintText();
        if (hint != null) return hint.toString();
        CharSequence description = node.getContentDescription();
        if (description != null) return description.toString();
        return node.getClassName() == null ? "" : node.getClassName().toString();
    }

    private static boolean setText(AccessibilityNodeInfo node, String text) {
        Bundle arguments = new Bundle();
        arguments.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
        return node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments);
    }

    /**
     * Submits through the send button when one is found, otherwise through the keyboard Enter
     * action on API 30+. Returns the path used, or null when TikTok offers neither.
     */
    private String submit(AccessibilityNodeInfo root, AccessibilityNodeInfo input) {
        AccessibilityNodeInfo button = findSendButton(root);
        if (button != null && button.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
            return "send_button";
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                && input.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.getId())) {
            return "ime_enter";
        }
        return null;
    }

    private AccessibilityNodeInfo findSendButton(AccessibilityNodeInfo root) {
        if (root == null) return null;
        Deque<AccessibilityNodeInfo> queue = new ArrayDeque<>();
        queue.add(root);
        int visited = 0;
        while (!queue.isEmpty() && visited < NODE_SCAN_BUDGET) {
            AccessibilityNodeInfo node = queue.poll();
            visited++;
            if (node.isClickable() && matchesSendLabel(node)) return node;
            for (int index = 0; index < node.getChildCount(); index++) {
                AccessibilityNodeInfo child = node.getChild(index);
                if (child != null) queue.add(child);
            }
        }
        return null;
    }

    private static boolean matchesSendLabel(AccessibilityNodeInfo node) {
        CharSequence description = node.getContentDescription();
        CharSequence text = node.getText();
        for (String label : SEND_LABELS) {
            if (description != null && description.toString().toLowerCase(Locale.ROOT).contains(label)) return true;
            if (text != null && text.toString().trim().toLowerCase(Locale.ROOT).equals(label)) return true;
        }
        return false;
    }

    /** Success means the chat box is empty again; a still-filled box is reported as unconfirmed. */
    private boolean waitForInputToClear(String hintKey) {
        long deadline = SystemClock.elapsedRealtime() + CONFIRM_TIMEOUT_MS;
        while (SystemClock.elapsedRealtime() < deadline) {
            AccessibilityNodeInfo input = findChatInput(currentRoot());
            if (input == null) return false;
            if (hintKeyOf(input).equals(hintKey)) {
                CharSequence text = input.getText();
                if (text == null || text.toString().trim().isEmpty()) return true;
            }
            SystemClock.sleep(CONFIRM_POLL_MS);
        }
        return false;
    }

    /** LIVE chat is a single line, so line breaks would be sent as separate attempts. */
    private static String singleLine(String comment) {
        return comment.replaceAll("[\\r\\n]+", " ").trim();
    }
}
