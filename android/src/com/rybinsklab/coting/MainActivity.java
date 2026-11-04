package com.rybinsklab.coting;

import android.app.Activity;
import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Coting — открытый кодинг-агент для Termux. Это Android-обёртка:
 * WebView грузит локальный веб-чат с node-сервера в Termux (127.0.0.1:8395),
 * умеет поднять сервер через Termux RUN_COMMAND и даёт агенту доступ к
 * управлению телефоном (жесты/скриншоты — Accessibility, блокировка — Device Admin).
 */
public class MainActivity extends Activity {

    private static final String SERVER_URL = "http://127.0.0.1:8395";
    private static final String COTINGD = "/data/data/com.termux/files/usr/bin/cotingd";

    private WebView web;
    private LinearLayout overlay;
    private TextView statusText;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        getWindow().setStatusBarColor(Color.parseColor("#212121"));
        getWindow().setNavigationBarColor(Color.parseColor("#212121"));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams lp = getWindow().getAttributes();
            lp.layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(lp);
        }

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                // наружу не выпускаем: всё, что не наш localhost, — системный браузер
                return !"127.0.0.1".equals(u.getHost());
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView wv, android.webkit.ValueCallback<Uri[]> cb,
                                             FileChooserParams params) {
                try {
                    Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    i.setType("*/*");
                    i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                    startActivityForResult(Intent.createChooser(i, "Прикрепить файл"), 77);
                    pendingChooser = cb;
                    return true;
                } catch (Exception e) {
                    return false;
                }
            }
        });

        setContentView(buildLayout());
        web.loadUrl(SERVER_URL);
        BridgeServer.ensure(this);
        requestMediaPermissions();
        checkServer();
    }

    /** Галерея/файлы: запрос на Android 13+ и на старых. */
    private void requestMediaPermissions() {
        try {
            String perm = Build.VERSION.SDK_INT >= 33
                    ? "android.permission.READ_MEDIA_IMAGES"
                    : "android.permission.READ_EXTERNAL_STORAGE";
            if (checkSelfPermission(perm) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{perm}, 101);
            }
        } catch (Exception e) { /* необязательно: прикрепление работает и через SAF */ }
    }

    /** file-input в чате: открываем системный выбор файлов (SAF, без прав). */


    private View buildLayout() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);

        root.addView(web, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));

        // оверлей «сервер не отвечает» — поверх WebView, по умолчанию скрыт
        overlay = new LinearLayout(this);
        overlay.setOrientation(LinearLayout.VERTICAL);
        overlay.setGravity(Gravity.CENTER);
        overlay.setBackgroundColor(Color.parseColor("#212121"));
        overlay.setVisibility(View.GONE);

        TextView cat = new TextView(this);
        cat.setText("🐱");
        cat.setTextSize(52);
        cat.setGravity(Gravity.CENTER);
        overlay.addView(cat);

        TextView title = new TextView(this);
        title.setText("Сервер Coting не отвечает");
        title.setTextSize(17);
        title.setTextColor(Color.WHITE);
        title.setGravity(Gravity.CENTER);
        title.setPadding(0, 24, 0, 8);
        overlay.addView(title);

        statusText = new TextView(this);
        statusText.setText("Termux жив? Поднять сервер одной кнопкой.");
        statusText.setTextSize(13);
        statusText.setTextColor(Color.parseColor("#9A9A9A"));
        statusText.setGravity(Gravity.CENTER);
        statusText.setPadding(40, 0, 40, 24);
        overlay.addView(statusText);

        Button start = new Button(this);
        start.setText("🐾 Запустить сервер в Termux");
        start.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { startTermuxServer(); }
        });
        overlay.addView(start, pad(80, 8));

        Button refresh = new Button(this);
        refresh.setText("Проверить снова");
        refresh.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { checkServer(); }
        });
        overlay.addView(refresh, pad(80, 8));

        Button a11y = new Button(this);
        a11y.setText("Настроить управление телефоном");
        a11y.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                // accessibility (жесты/скрин/текст) — включается вручную владельцем
                try {
                    startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS));
                } catch (Exception e) { /* нет такой настройки — игнор */ }
            }
        });
        overlay.addView(a11y, pad(80, 8));

        Button admin = new Button(this);
        admin.setText("🔒 Выдать права администратора (блокировка экрана)");
        admin.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { requestAdmin(); }
        });
        overlay.addView(admin, pad(80, 8));

        Button guide = new Button(this);
        guide.setText("📖 Инструкция: чистый Termux за минуту");
        guide.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { showGuide(); }
        });
        overlay.addView(guide, pad(80, 8));

        TextView copyright = new TextView(this);
        copyright.setText("© 2026 RybinskLab — rybinsklab.ru");
        copyright.setTextSize(12);
        copyright.setTextColor(Color.parseColor("#9A9A9A"));
        copyright.setGravity(Gravity.CENTER);
        copyright.setPadding(0, 18, 0, 0);
        overlay.addView(copyright);

        root.addView(overlay, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));
        return root;
    }

    private static final String INSTALL_CMD =
            "curl -fsSL https://raw.githubusercontent.com/RybinskLab/coting/main/install.sh | bash";

    /** Инструкция для чистого Termux: скачать + команда установки (копирование). */
    private void showGuide() {
        String msg = "1. Установи Termux (кнопка ниже — F-Droid, официальная сборка).\n\n"
                + "2. Открой Termux и выполни команду установки (кнопка «Скопировать» — потом вставь в Termux долгим тапом → Paste):\n\n"
                + INSTALL_CMD + "\n\n"
                + "Скрипт сам поставит nodejs, ripgrep, git, скачает сервер, пропишет доступы (allow-external-apps для кнопки «Запустить сервер») и запустит чат.\n\n"
                + "3. Вернись сюда — всё заработает автоматически.\n\n"
                + "Управление телефоном: кнопки выше (accessibility — жесты/скриншоты/текст, admin — блокировка экрана). Всё включается только твоими руками.\n\n"
                + "© 2026 RybinskLab — rybinsklab.ru";

        ScrollView sv = new ScrollView(this);
        TextView tv = new TextView(this);
        tv.setText(msg);
        tv.setTextSize(13.5f);
        tv.setLineSpacing(4, 1.1f);
        tv.setPadding(36, 24, 36, 12);
        sv.addView(tv);

        android.app.AlertDialog d = new android.app.AlertDialog.Builder(this)
                .setTitle("🐾 Установка Coting в Termux")
                .setView(sv)
                .setPositiveButton("Скачать Termux", new android.content.DialogInterface.OnClickListener() {
                    @Override public void onClick(android.content.DialogInterface di, int which) {
                        try {
                            startActivity(new Intent(Intent.ACTION_VIEW,
                                    Uri.parse("https://f-droid.org/packages/com.termux/")));
                        } catch (Exception e) { /* нет браузера */ }
                    }
                })
                .setNeutralButton("Скопировать команду", new android.content.DialogInterface.OnClickListener() {
                    @Override public void onClick(android.content.DialogInterface di, int which) {
                        android.content.ClipboardManager cm =
                                (android.content.ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                        cm.setPrimaryClip(android.content.ClipData.newPlainText("coting", INSTALL_CMD));
                        android.widget.Toast.makeText(MainActivity.this,
                                "команда скопирована — вставь в Termux", android.widget.Toast.LENGTH_LONG).show();
                    }
                })
                .setNegativeButton("Закрыть", null)
                .create();
        d.show();
    }

    /** Диалог активации Device Admin (политика force-lock). */
    private void requestAdmin() {
        try {
            ComponentName cn = new ComponentName(this, AdminReceiver.class);
            Intent i = new Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN);
            i.putExtra(DevicePolicyManager.EXTRA_DEVICE_ADMIN, cn);
            i.putExtra(DevicePolicyManager.EXTRA_ADD_EXPLANATION,
                    "Позволяет Coting блокировать экран по команде из чата (только force-lock).");
            startActivity(i);
        } catch (Exception e) { /* нет администрирования на устройстве */ }
    }

    private LinearLayout.LayoutParams pad(int side, int vgap) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        p.setMargins(side, vgap / 2, side, vgap / 2);
        return p;
    }

    private void showOverlay(boolean show, String status) {
        overlay.setVisibility(show ? View.VISIBLE : View.GONE);
        web.setVisibility(show ? View.GONE : View.VISIBLE);
        if (status != null) statusText.setText(status);
    }

    private void checkServer() {
        showOverlay(true, "проверяю сервер…");
        new Thread(new Runnable() {
            @Override public void run() {
                boolean down = false;
                String extra = "";
                try {
                    HttpURLConnection c = (HttpURLConnection) new URL(SERVER_URL + "/api/health")
                            .openConnection();
                    c.setConnectTimeout(1500);
                    c.setReadTimeout(1500);
                    down = c.getResponseCode() != 200;
                } catch (Exception e) {
                    down = true;
                    extra = "нет соединения. ";
                }
                extra += "Termux запущен? Сервер ставится командой: coting start";
                final boolean fdown = down;
                final String fextra = extra;
                runOnUiThread(new Runnable() {
                    @Override public void run() {
                        if (fdown) showOverlay(true, fextra);
                        else showOverlay(false, null);
                    }
                });
            }
        }).start();
    }

    /** RUN_COMMAND → Termux: ~/bin/cotingd start (zbridge-паттерн). */
    private void startTermuxServer() {
        try {
            Intent i = new Intent("com.termux.RUN_COMMAND");
            i.setClassName("com.termux", "com.termux.app.RunCommandService");
            i.putExtra("com.termux.RUN_COMMAND_PATH", COTINGD);
            i.putExtra("com.termux.RUN_COMMAND_ARGUMENTS", new String[]{"start"});
            i.putExtra("com.termux.RUN_COMMAND_BACKGROUND", true);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(i);
            } else {
                startService(i);
            }
            showOverlay(true, "команда отправлена в Termux, ждём ~3с…");
            web.postDelayed(new Runnable() { @Override public void run() { checkServer(); } }, 3500);
        } catch (Exception e) {
            showOverlay(true, "не удалось: " + e.getMessage() + ". Открой Termux → coting start");
        }
    }

    private android.webkit.ValueCallback<Uri[]> pendingChooser;

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == 77 && pendingChooser != null) {
            java.util.ArrayList<Uri> uris = new java.util.ArrayList<>();
            if (data != null && data.getClipData() != null) {
                for (int i = 0; i < data.getClipData().getItemCount(); i++)
                    uris.add(data.getClipData().getItemAt(i).getUri());
            } else if (data != null && data.getData() != null) {
                uris.add(data.getData());
            }
            pendingChooser.onReceiveValue(uris.toArray(new Uri[0]));
            pendingChooser = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
        if (web != null) checkServer();
    }

    @Override
    protected void onPause() {
        if (web != null) web.onPause();
        super.onPause();
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }
}
