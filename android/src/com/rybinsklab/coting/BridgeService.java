package com.rybinsklab.coting;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.graphics.Bitmap;
import android.graphics.Path;
import android.graphics.Rect;
import android.hardware.display.DisplayManager;
import android.os.Build;
import android.util.Base64;
import android.view.Display;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Accessibility-сервис Coting: агент тапает, свайпает, читает текст экрана,
 * жмёт системные кнопки и делает скриншоты. Включается владельцем телефона
 * вручную (Настройки → Спец. возможности) — никаких скрытых режимов.
 * Команды прилетают только с localhost через BridgeServer (:8396).
 */
public class BridgeService extends AccessibilityService {

    private static final AtomicReference<BridgeService> INSTANCE = new AtomicReference<>(null);

    @Override
    protected void onServiceConnected() {
        INSTANCE.set(this);
        super.onServiceConnected();
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) { }

    @Override
    public void onInterrupt() { }

    @Override
    public boolean onUnbind(android.content.Intent intent) {
        INSTANCE.set(null);
        return super.onUnbind(intent);
    }

    // ---------------- API для BridgeServer ----------------

    public static boolean alive() {
        return INSTANCE.get() != null;
    }

    /** false = сервис не включён (нужно Settings → Спец. возможности). */
    public static boolean tap(int x, int y, boolean longPress) {
        return gesture(pathTo(x, y, x, y), longPress ? 700 : 60);
    }

    public static boolean swipe(int x1, int y1, int x2, int y2, long ms) {
        return gesture(pathTo(x1, y1, x2, y2), Math.max(50, ms));
    }

    /** back / home / recents — системные действия. */
    public static boolean globalAction(String name) {
        BridgeService svc = INSTANCE.get();
        if (svc == null) return false;
        int action;
        switch (name) {
            case "back": action = GLOBAL_ACTION_BACK; break;
            case "home": action = GLOBAL_ACTION_HOME; break;
            case "recents": action = GLOBAL_ACTION_RECENTS; break;
            case "notifications": action = GLOBAL_ACTION_NOTIFICATIONS; break;
            default: return false;
        }
        return svc.performGlobalAction(action);
    }

    /** Текст активного окна (упрощённый обход дерева). */
    public static String screenText(int maxChars) {
        BridgeService svc = INSTANCE.get();
        if (svc == null) return null;
        AccessibilityNodeInfo root = svc.getRootInActiveWindow();
        if (root == null) return "(нет активного окна)";
        StringBuilder sb = new StringBuilder();
        walk(root, sb, 0, 8);
        String s = sb.toString();
        if (s.length() > maxChars) s = s.substring(0, maxChars) + "\n…[обрезано]";
        return s;
    }

    private static void walk(AccessibilityNodeInfo n, StringBuilder sb, int depth, int maxDepth) {
        if (n == null || depth > maxDepth || sb.length() > 16000) return;
        CharSequence t = n.getText();
        if (t != null && t.length() > 0) {
            Rect r = new Rect();
            n.getBoundsInScreen(r);
            sb.append("[").append(r.left).append(",").append(r.top).append("] ").append(t).append('\n');
        }
        for (int i = 0; i < n.getChildCount(); i++) walk(n.getChild(i), sb, depth + 1, maxDepth);
    }

    /**
     * Скриншот через AccessibilityService.takeScreenshot (Android 11+).
     * Возвращает PNG в base64 (компактно передать через локальный HTTP).
     */
    public static String screenshotBase64(int maxWidth, int timeoutMs) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null;
        BridgeService svc = INSTANCE.get();
        if (svc == null) return null;
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<Bitmap> result = new AtomicReference<>(null);
        svc.takeScreenshot(Display.DEFAULT_DISPLAY, svc.getMainExecutor(),
                new AccessibilityService.TakeScreenshotCallback() {
                    @Override
                    public void onSuccess(AccessibilityService.ScreenshotResult screenshot) {
                        try {
                            android.hardware.HardwareBuffer hb = screenshot.getHardwareBuffer();
                            result.set(Bitmap.wrapHardwareBuffer(hb, screenshot.getColorSpace()));
                        } catch (Exception e) {
                            result.set(null);
                        }
                        latch.countDown();
                    }

                    @Override
                    public void onFailure(int errorCode) {
                        latch.countDown();
                    }
                });
        try {
            latch.await(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            return null;
        }
        Bitmap bmp = result.get();
        if (bmp == null) return null;
        // уменьшаем, чтобы base64 не разъедал контекст агента
        int w = bmp.getWidth(), h = bmp.getHeight();
        if (w > maxWidth) {
            h = h * maxWidth / w;
            Bitmap scaled = Bitmap.createScaledBitmap(bmp, maxWidth, h, true);
            if (scaled != bmp) bmp.recycle();
            bmp = scaled;
        }
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        bmp.compress(Bitmap.CompressFormat.PNG, 60, bos);
        bmp.recycle();
        return Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP);
    }

    // ---------------- утилиты жестов ----------------

    private static Path pathTo(int x1, int y1, int x2, int y2) {
        Path p = new Path();
        p.moveTo(x1, y1);
        if (x1 != x2 || y1 != y2) p.lineTo(x2, y2);
        return p;
    }

    private static boolean gesture(Path path, long ms) {
        BridgeService svc = INSTANCE.get();
        if (svc == null) return false;
        GestureDescription.StrokeDescription stroke =
                new GestureDescription.StrokeDescription(path, 0L, ms);
        GestureDescription g = new GestureDescription.Builder().addStroke(stroke).build();
        return svc.dispatchGesture(g, null, null);
    }
}
