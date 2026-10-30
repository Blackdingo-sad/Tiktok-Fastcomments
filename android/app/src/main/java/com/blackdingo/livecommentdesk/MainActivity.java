package com.blackdingo.livecommentdesk;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Intent;
import android.os.Bundle;
import android.provider.Settings;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;

import java.util.Locale;

public class MainActivity extends Activity {

    private TextView statusValue;
    private TextView resultValue;
    private TextView timingValue;
    private EditText commentInput;
    private Button sendNow;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        statusValue = findViewById(R.id.statusValue);
        resultValue = findViewById(R.id.resultValue);
        timingValue = findViewById(R.id.timingValue);
        commentInput = findViewById(R.id.commentInput);
        sendNow = findViewById(R.id.sendNow);

        findViewById(R.id.openSettings).setOnClickListener(view ->
                startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)));

        findViewById(R.id.openTiktok).setOnClickListener(view -> {
            String packageName = SendAccessibilityService.installedTikTokPackage(this);
            if (packageName == null) {
                showNotice("Không tìm thấy TikTok trên máy này.");
                return;
            }
            Intent launch = getPackageManager().getLaunchIntentForPackage(packageName);
            if (launch == null) {
                showNotice("Không mở được TikTok.");
                return;
            }
            startActivity(launch);
        });

        sendNow.setOnClickListener(view -> sendOnce());
    }

    @Override
    protected void onResume() {
        super.onResume();
        boolean enabled = isServiceEnabled();
        statusValue.setText(enabled ? R.string.status_on : R.string.status_off);
        statusValue.setTextColor(getColor(enabled ? R.color.ink : R.color.warn));
        sendNow.setEnabled(enabled);
    }

    private void sendOnce() {
        String comment = commentInput.getText().toString().trim();
        if (comment.isEmpty()) {
            showNotice("Chưa có nội dung để gửi.");
            return;
        }
        SendAccessibilityService service = SendAccessibilityService.get();
        if (service == null) {
            showNotice("Dịch vụ trợ năng chưa chạy. Bật lại trong cài đặt trợ năng.");
            return;
        }
        resultValue.setText("Đang gửi…");
        resultValue.setTextColor(getColor(R.color.ink_muted));
        timingValue.setText(R.string.timing_idle);
        sendNow.setEnabled(false);
        boolean started = service.sendComment(comment, result -> runOnUiThread(() -> showResult(result)));
        if (!started) {
            sendNow.setEnabled(true);
            showNotice("Lần gửi trước chưa xong.");
        }
    }

    private void showNotice(String message) {
        resultValue.setText(message);
        resultValue.setTextColor(getColor(R.color.warn));
    }

    private void showResult(SendAccessibilityService.Result result) {
        sendNow.setEnabled(isServiceEnabled());
        resultValue.setText(describe(result));
        resultValue.setTextColor(getColor(result.ok ? R.color.success : R.color.warn));
        if (!result.ok && result.total() == 0) {
            // Nothing ran, so there is no stage to report; zero milliseconds would read as a fast send.
            timingValue.setText("Không có chặng nào chạy, nên không có số đo.");
            return;
        }
        timingValue.setText(String.format(Locale.US,
                "TikTok lên trước %d ms · ô chat %d ms · đặt chữ %d ms · bấm gửi %d ms · xác nhận %d ms\n"
                        + "tổng %d ms · đường gửi: %s",
                result.tapToTiktok, result.tiktokToInput, result.inputToText, result.textToSubmit,
                result.submitToConfirm, result.total(), result.submitPath));
    }

    private String describe(SendAccessibilityService.Result result) {
        if (result.ok) return "Đã gửi: ô chat trống trở lại sau khi bấm.";
        switch (result.reason) {
            case "tiktok_not_foreground":
                return "Không đưa được TikTok lên trước. Mở TikTok rồi thử lại.";
            case "chat_input_not_found":
                return "Không thấy ô bình luận. Mở đúng phòng LIVE trong TikTok trước.";
            case "set_text_refused":
                return "TikTok không nhận chữ vào ô bình luận.";
            case "submit_control_not_found":
                return "Không thấy nút gửi hay phím Enter trong phòng LIVE.";
            case "send_unconfirmed":
                return "Chưa xác nhận: ô bình luận vẫn còn chữ. Không tự gửi lại.";
            default:
                return "Không gửi được: " + result.reason;
        }
    }

    private boolean isServiceEnabled() {
        // Android stores the same component two ways ("pkg/.Service" and "pkg/pkg.Service"), so the
        // stored string has to be parsed as a ComponentName instead of compared as text.
        ComponentName expected = new ComponentName(this, SendAccessibilityService.class);
        String enabled = Settings.Secure.getString(getContentResolver(),
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        if (enabled != null) {
            for (String entry : enabled.split(":")) {
                if (expected.equals(ComponentName.unflattenFromString(entry))) return true;
            }
        }
        return SendAccessibilityService.get() != null;
    }
}
