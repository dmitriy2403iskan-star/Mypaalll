package com.mypal.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.content.res.AssetManager;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Фоновый сервис: распаковывает приложение MyPal из assets/app.zip и запускает его встроенным Node.js.
 * Node (сборка Termux под Android) лежит в nativeLibraryDir как libnode.so — только оттуда Android 10+ разрешает exec.
 */
public class NodeService extends Service {
    public static final String TAG = "MyPal";
    public static final int PORT = 3000;
    private static final String CHANNEL = "mypal";

    private static volatile Process process;
    private static volatile String status = "Запуск…";
    private PowerManager.WakeLock wakeLock;
    private WifiManager.MulticastLock multicastLock;

    public static String getStatus() { return status; }
    public static boolean isRunning() { return process != null && process.isAlive(); }

    public static File logFile(Context c) { return new File(c.getFilesDir(), "node.log"); }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification n = buildNotification("MyPal работает в фоне");
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(1, n);
        }
        if (!isRunning()) new Thread(this::startNode, "node-launcher").start();
        return START_STICKY;
    }

    private void startNode() {
        try {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "MyPal:node");
            wakeLock.acquire();
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
            if (wm != null) {
                multicastLock = wm.createMulticastLock("MyPal:lan");
                multicastLock.acquire();
            }

            File appDir = new File(getFilesDir(), "app");
            File stamp = new File(appDir, ".version");
            String version = BuildConfigCompat.versionCode(this);
            if (!stamp.exists() || !version.equals(readFile(stamp))) {
                status = "Распаковка приложения (первый запуск, ~1 минута)…";
                deleteRecursive(appDir);
                unzipAsset(getAssets(), "app.zip", appDir);
                copyAsset(getAssets(), "cacert.pem", new File(getFilesDir(), "cacert.pem"));
                writeFile(stamp, version);
            }

            // журнал не должен расти бесконечно
            File log = logFile(this);
            if (log.length() > 2_000_000) log.delete();

            String libDir = getApplicationInfo().nativeLibraryDir;
            File node = new File(libDir, "libnode.so");
            File dataDir = new File(getFilesDir(), "data");
            dataDir.mkdirs();
            File tmp = getCacheDir();
            File ca = new File(getFilesDir(), "cacert.pem");

            ProcessBuilder pb = new ProcessBuilder(
                    node.getAbsolutePath(),
                    "--no-warnings=ExperimentalWarning",
                    "src/index.js");
            pb.directory(appDir);
            pb.redirectErrorStream(true);
            pb.redirectOutput(ProcessBuilder.Redirect.appendTo(logFile(this)));
            Map<String, String> env = pb.environment();
            env.put("LD_LIBRARY_PATH", libDir);
            env.put("HOME", getFilesDir().getAbsolutePath());
            env.put("TMPDIR", tmp.getAbsolutePath());
            env.put("DATA_DIR", dataDir.getAbsolutePath());
            env.put("PORT", String.valueOf(PORT));
            env.put("HOST", "127.0.0.1");
            env.put("SSL_CERT_FILE", ca.getAbsolutePath());
            env.put("NODE_EXTRA_CA_CERTS", ca.getAbsolutePath());
            env.put("NODE_ENV", "production");
            // на телефоне по умолчанию — Bedrock в этом же устройстве (меняется в панели)
            env.put("MC_EDITION", "bedrock");
            env.put("BEDROCK_HOST", "127.0.0.1");
            env.put("BEDROCK_AUTH", "microsoft");

            status = "Запуск Node.js…";
            Log.i(TAG, "exec " + node + " in " + appDir);
            process = pb.start();
            status = "Работает";
            int code = process.waitFor();
            status = "Node.js остановился (код " + code + "). Подробности в журнале.";
            Log.w(TAG, status);
        } catch (Throwable t) {
            status = "Ошибка запуска: " + t;
            Log.e(TAG, "start failed", t);
            try {
                writeFile(logFile(this), readFileSafe(logFile(this)) + "\n[MyPal] " + status + "\n");
            } catch (IOException ignored) { }
        } finally {
            process = null;
            release();
        }
    }

    private void release() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (multicastLock != null && multicastLock.isHeld()) multicastLock.release();
    }

    @Override
    public void onDestroy() {
        Process p = process;
        if (p != null) p.destroy();
        release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    // ------------------------------------------------------------ уведомление
    private void createChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "MyPal", NotificationManager.IMPORTANCE_LOW);
            getSystemService(NotificationManager.class).createNotificationChannel(ch);
        }
    }

    private Notification buildNotification(String text) {
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        return b.setContentTitle("MyPal")
                .setContentText(text)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentIntent(pi)
                .setOngoing(true)
                .build();
    }

    // ------------------------------------------------------------ файлы
    static void unzipAsset(AssetManager am, String name, File dest) throws IOException {
        dest.mkdirs();
        String root = dest.getCanonicalPath() + File.separator;
        byte[] buf = new byte[1 << 16];
        try (ZipInputStream zin = new ZipInputStream(new BufferedInputStream(am.open(name), 1 << 16))) {
            ZipEntry e;
            while ((e = zin.getNextEntry()) != null) {
                File f = new File(dest, e.getName());
                if (!f.getCanonicalPath().startsWith(root)) throw new IOException("bad zip entry " + e.getName());
                if (e.isDirectory()) { f.mkdirs(); continue; }
                f.getParentFile().mkdirs();
                try (OutputStream out = new FileOutputStream(f)) {
                    int n;
                    while ((n = zin.read(buf)) > 0) out.write(buf, 0, n);
                }
            }
        }
    }

    static void copyAsset(AssetManager am, String name, File dest) throws IOException {
        try (InputStream in = am.open(name); OutputStream out = new FileOutputStream(dest)) {
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
    }

    static void deleteRecursive(File f) {
        if (f.isDirectory()) {
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) deleteRecursive(k);
        }
        f.delete();
    }

    static String readFile(File f) {
        try { return readFileSafe(f).trim(); } catch (IOException e) { return ""; }
    }

    static String readFileSafe(File f) throws IOException {
        if (!f.exists()) return "";
        try (InputStream in = new java.io.FileInputStream(f)) {
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            return bos.toString("UTF-8");
        }
    }

    static void writeFile(File f, String s) throws IOException {
        try (OutputStream out = new FileOutputStream(f)) {
            out.write(s.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        }
    }
}
