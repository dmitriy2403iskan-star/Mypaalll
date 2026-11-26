package com.mypal.app;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.Html;
import android.view.View;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.File;
import java.net.HttpURLConnection;
import java.net.URL;

/** Показывает веб-панель MyPal (http://127.0.0.1:3000), которую поднимает NodeService. */
public class MainActivity extends Activity {
    private static final String PANEL = "http://127.0.0.1:" + NodeService.PORT + "/";
    private WebView web;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private boolean panelLoaded = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.parseColor("#1b2027"));

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#12151a"));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                // ссылки наружу (вход Microsoft, сайты провайдеров) — в обычный браузер
                if (!"127.0.0.1".equals(u.getHost()) && !"localhost".equals(u.getHost())) {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                    return true;
                }
                return false;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) { panelLoaded = false; ui.postDelayed(MainActivity.this::poll, 1000); }
            }
        });
        setContentView(web);

        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
        }
        Intent svc = new Intent(this, NodeService.class);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(svc); else startService(svc);
        poll();
    }

    /** Ждём, пока сервер ответит; до этого показываем статус и хвост журнала. */
    private void poll() {
        if (panelLoaded) return;
        new Thread(() -> {
            boolean up = false;
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(PANEL + "api/settings").openConnection();
                c.setConnectTimeout(800);
                c.setReadTimeout(1500);
                up = c.getResponseCode() > 0;
                c.disconnect();
            } catch (Exception ignored) { }
            final boolean ready = up;
            ui.post(() -> {
                if (ready) {
                    panelLoaded = true;
                    web.loadUrl(PANEL);
                } else {
                    showStatus();
                    ui.postDelayed(this::poll, 1500);
                }
            });
        }).start();
    }

    private void showStatus() {
        String log = tail(NodeService.logFile(this), 3000);
        String html = "<html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head>"
                + "<body style='background:#12151a;color:#e6e9ee;font-family:sans-serif;padding:16px'>"
                + "<h2>⛏ MyPal</h2><p>" + Html.escapeHtml(NodeService.getStatus()) + "</p>"
                + (log.isEmpty() ? "" : "<pre style='white-space:pre-wrap;font-size:11px;color:#8b95a3'>" + Html.escapeHtml(log) + "</pre>")
                + "</body></html>";
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    private static String tail(File f, int max) {
        String s = NodeService.readFile(f);
        return s.length() > max ? s.substring(s.length() - max) : s;
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else moveTaskToBack(true); // не закрываем: сервер продолжает работать в фоне
    }
}
