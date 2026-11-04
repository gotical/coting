package com.rybinsklab.coting;

import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Context;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketException;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Локальный мост Android → агент: HTTP на 127.0.0.1:8396, слушает только
 * loopback. Команды управления телефоном из чата Coting (инструмент
 * android_device в Termux дергает этот сервер).
 *
 *   GET  /status     — какие возможности включены (a11y/admin)
 *   POST /tap        {"x":..,"y":..,"long":true|false}
 *   POST /swipe      {"x1":..,"y1":..,"x2":..,"y2":..,"ms":..}
 *   POST /action     {"name":"back|home|recents|notifications|lock"}
 *   GET  /text       — текст активного окна (с координатами)
 *   GET  /screenshot — PNG base64 (Android 11+)
 *
 * bind только на 127.0.0.1; сервер поднимается из MainActivity при старте.
 */
public class BridgeServer extends Thread {

    public static final int PORT = 8396;
    private static final AtomicBoolean RUNNING = new AtomicBoolean(false);

    public static boolean isRunning() { return RUNNING.get(); }

    private final Context app;
    private ServerSocket socket;

    public BridgeServer(Context app) {
        this.app = app.getApplicationContext();
        setDaemon(true);
        setName("CotingBridge");
    }

    public static synchronized void ensure(Context ctx) {
        if (!RUNNING.get()) new BridgeServer(ctx).start();
    }

    @Override
    public void run() {
        if (!RUNNING.compareAndSet(false, true)) return;
        try {
            socket = new ServerSocket(PORT, 16, java.net.InetAddress.getByName("127.0.0.1"));
            while (RUNNING.get()) {
                try (Socket s = socket.accept()) {
                    handle(s);
                } catch (SocketException e) {
                    break;
                } catch (Exception e) {
                    // отдельный клиент не валит сервер
                }
            }
        } catch (IOException e) {
            // порт занят или нет прав — молча: /status у клиента скажет «нет моста»
        } finally {
            RUNNING.set(false);
        }
    }

    public static void stopServer() {
        RUNNING.set(false);
        try { /* accept разблокируется исключением при close */ } catch (Exception e) { }
    }

    private void handle(Socket s) throws IOException {
        BufferedReader in = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.UTF_8));
        String requestLine = in.readLine();
        if (requestLine == null) return;
        // читаем заголовки до пустой строки и тело по content-length
        int contentLength = 0;
        String line;
        while ((line = in.readLine()) != null && !line.isEmpty()) {
            String[] parts = line.split(":", 2);
            if (parts.length == 2 && parts[0].equalsIgnoreCase("content-length")) {
                try { contentLength = Integer.parseInt(parts[1].trim()); } catch (NumberFormatException ignored) { }
            }
        }
        StringBuilder body = new StringBuilder();
        if (contentLength > 0 && contentLength < 65536) {
            char[] buf = new char[contentLength];
            int read = 0;
            while (read < contentLength) {
                int r = in.read(buf, read, contentLength - read);
                if (r < 0) break;
                read += r;
            }
            body.append(buf, 0, read);
        }

        String[] rl = requestLine.split(" ");
        String method = rl.length > 0 ? rl[0] : "";
        String path = rl.length > 1 ? rl[1] : "/";
        if (path.contains("?")) path = path.substring(0, path.indexOf('?'));

        String json = route(method, path, body.toString());
        byte[] out = json.getBytes(StandardCharsets.UTF_8);
        OutputStream os = s.getOutputStream();
        os.write(("HTTP/1.1 200 OK\r\ncontent-type: application/json; charset=utf-8\r\n"
                + "content-length: " + out.length + "\r\nconnection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));
        os.write(out);
        os.flush();
    }

    private static int jint(String body, String key, int dflt) {
        Matcher m = Pattern.compile("\"" + key + "\"\\s*:\\s*(-?\\d+)").matcher(body);
        return m.find() ? Integer.parseInt(m.group(1)) : dflt;
    }

    private static boolean jbool(String body, String key) {
        return Pattern.compile("\"" + key + "\"\\s*:\\s*true").matcher(body).find();
    }

    private static String jstr(String body, String key) {
        Matcher m = Pattern.compile("\"" + key + "\"\\s*:\\s*\"([^\"]*)\"").matcher(body);
        return m.find() ? m.group(1) : null;
    }

    private static String ok(String pairs) { return "{\"ok\":true," + pairs + "}"; }
    private static String err(String msg) { return "{\"ok\":false,\"error\":\"" + msg + "\"}"; }

    private String route(String method, String path, String body) {
        try {
            switch (path) {
                case "/status": {
                    boolean a11y = BridgeService.alive();
                    boolean admin = isAdminActive();
                    return ok("\"a11y\":" + a11y + ",\"admin\":" + admin
                            + ",\"screenshot\":" + (android.os.Build.VERSION.SDK_INT >= 30 && a11y)
                            + ",\"app\":\"coting-bridge\",\"port\":" + PORT);
                }
                case "/tap": {
                    if (!BridgeService.alive()) return err("accessibility-сервис не включён");
                    boolean okTap = BridgeService.tap(jint(body, "x", 0), jint(body, "y", 0), jbool(body, "long"));
                    return okTap ? ok("\"tapped\":true") : err("жест не прошёл");
                }
                case "/swipe": {
                    if (!BridgeService.alive()) return err("accessibility-сервис не включён");
                    boolean okSwipe = BridgeService.swipe(jint(body, "x1", 0), jint(body, "y1", 0),
                            jint(body, "x2", 0), jint(body, "y2", 0), jint(body, "ms", 300));
                    return okSwipe ? ok("\"swiped\":true") : err("жест не прошёл");
                }
                case "/action": {
                    String name = jstr(body, "name");
                    if (name == null) return err("нет name");
                    if ("lock".equals(name)) {
                        if (!isAdminActive()) return err("права администратора не выданы");
                        dpm().lockNow();
                        return ok("\"locked\":true");
                    }
                    if (!BridgeService.alive()) return err("accessibility-сервис не включён");
                    boolean done = BridgeService.globalAction(name);
                    return done ? ok("\"action\":\"" + name + "\"") : err("неизвестное действие: " + name);
                }
                case "/text": {
                    if (!BridgeService.alive()) return err("accessibility-сервис не включён");
                    String t = BridgeService.screenText(8000);
                    // JSON-safe: экранируем самое опасное
                    t = t.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "").replace("\t", " ");
                    return ok("\"text\":\"" + t + "\"");
                }
                case "/screenshot": {
                    String b64 = BridgeService.screenshotBase64(720, 4000);
                    if (b64 == null) return err("скриншот недоступен (нужен Android 11+ и включённый accessibility)");
                    return ok("\"png_base64\":\"" + b64 + "\"");
                }
                default:
                    return err("нет такого маршрута: " + path);
            }
        } catch (Exception e) {
            return err(e.getMessage() == null ? "внутренняя ошибка" : e.getMessage());
        }
    }

    private DevicePolicyManager dpm() {
        return (DevicePolicyManager) app.getSystemService(Context.DEVICE_POLICY_SERVICE);
    }

    private boolean isAdminActive() {
        ComponentName cn = new ComponentName(app, AdminReceiver.class);
        return dpm().isAdminActive(cn);
    }
}
