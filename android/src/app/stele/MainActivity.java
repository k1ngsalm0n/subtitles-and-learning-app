package app.stele;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.res.AssetManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * Stele for Android: the phone edition (scripts/build-phone.mjs) inside a
 * WebView. Everything the app does happens in the page — it answers its own
 * /api/… requests and talks to Groq with the reader's key — so this class
 * only does what a browser would have done for it:
 *
 *  - serves the page's files out of the APK's assets, on an https address
 *    (ES modules refuse file://, and IndexedDB wants a real origin);
 *  - opens the system file picker for <input type="file">;
 *  - saves Export's file through the system "Save to…" screen (a WebView
 *    has no downloads); android.js on the page hands it the bytes;
 *  - lets a video go full screen, and the back button close a pop-up
 *    before it leaves the app.
 */
public class MainActivity extends Activity {
    static final String HOST = "appassets.androidplatform.net";
    static final String ORIGIN = "https://" + HOST + "/";
    static final String TAG = "Stele";
    static final int PICK_FILE = 1;
    static final int SAVE_FILE = 2;

    WebView web;
    FrameLayout root;
    ValueCallback<Uri[]> pendingPick;
    byte[] pendingSave;
    View fullscreenView;
    WebChromeClient.CustomViewCallback fullscreenCallback;

    static final Map<String, String> MIME = new HashMap<>();
    static {
        MIME.put("html", "text/html");
        MIME.put("js", "text/javascript");
        MIME.put("mjs", "text/javascript");
        MIME.put("css", "text/css");
        MIME.put("json", "application/json");
        MIME.put("webmanifest", "application/manifest+json");
        MIME.put("svg", "image/svg+xml");
        MIME.put("png", "image/png");
        MIME.put("jpg", "image/jpeg");
        MIME.put("ico", "image/x-icon");
        MIME.put("txt", "text/plain");
        MIME.put("woff2", "font/woff2");
        MIME.put("mp4", "video/mp4");
        MIME.put("vtt", "text/vtt");
        MIME.put("srt", "text/plain");
    }

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0d0f12"));
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
        keepClearOfSystemBars();

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setTextZoom(100);

        web.addJavascriptInterface(new Bridge(), "SteleAndroid");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        if (saved != null) web.restoreState(saved);
        if (web.getUrl() == null) web.loadUrl(ORIGIN + "index.html");
        // Android 13+ hands back to a registered callback (and, from 16, no
        // longer calls onBackPressed at all).
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::goBack);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    /** Android 15 draws every app under the status and navigation bars; pad the page clear of them. */
    void keepClearOfSystemBars() {
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            int l, t, r, b;
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets i = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                l = i.left; t = i.top; r = i.right; b = i.bottom;
            } else {
                l = insets.getSystemWindowInsetLeft(); t = insets.getSystemWindowInsetTop();
                r = insets.getSystemWindowInsetRight(); b = insets.getSystemWindowInsetBottom();
            }
            v.setPadding(l, t, r, b);
            return insets;
        });
    }

    /** The page's own files, from assets/www. */
    class Client extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
            Uri url = req.getUrl();
            if (!HOST.equals(url.getHost())) return null;
            String path = url.getPath() == null ? "/" : url.getPath();
            if (path.endsWith("/")) path += "index.html";
            Map<String, String> headers = new HashMap<>();
            headers.put("Cache-Control", "no-cache");
            // The files are already on the phone; a service worker would only
            // keep a second, older copy of them.
            if (path.equals("/sw.js") || path.contains("..")) return notFound(headers);
            try {
                InputStream in = getAssets().open("www" + path, AssetManager.ACCESS_STREAMING);
                String ext = path.substring(path.lastIndexOf('.') + 1).toLowerCase();
                String mime = MIME.containsKey(ext) ? MIME.get(ext) : "application/octet-stream";
                return new WebResourceResponse(mime, "utf-8", 200, "OK", headers, in);
            } catch (IOException e) {
                return notFound(headers);
            }
        }

        WebResourceResponse notFound(Map<String, String> headers) {
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers, null);
        }

        /** Links away from the app (Groq's key page, a licence) open in the browser. */
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            Uri url = req.getUrl();
            if (HOST.equals(url.getHost())) return false;
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, url));
            } catch (ActivityNotFoundException e) {
                Log.w(TAG, "No app opens " + url);
            }
            return true;
        }
    }

    class Chrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (pendingPick != null) pendingPick.onReceiveValue(null);
            pendingPick = callback;
            Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
            pick.addCategory(Intent.CATEGORY_OPENABLE);
            String[] types = params.getAcceptTypes();
            String type = types.length == 1 && types[0].contains("/") ? types[0] : "*/*";
            pick.setType(type);
            if (types.length > 1) pick.putExtra(Intent.EXTRA_MIME_TYPES, types);
            // A video's sound is as good as the video: let audio through too.
            if (type.equals("video/*")) {
                pick.setType("*/*");
                pick.putExtra(Intent.EXTRA_MIME_TYPES, new String[] {"video/*", "audio/*"});
            }
            if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            try {
                startActivityForResult(Intent.createChooser(pick, null), PICK_FILE);
            } catch (ActivityNotFoundException e) {
                pendingPick = null;
                return false;
            }
            return true;
        }

        @Override
        public void onShowCustomView(View view, CustomViewCallback callback) {
            if (fullscreenView != null) { callback.onCustomViewHidden(); return; }
            fullscreenView = view;
            fullscreenCallback = callback;
            root.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            web.setVisibility(View.GONE);
        }

        @Override
        public void onHideCustomView() {
            if (fullscreenView == null) return;
            root.removeView(fullscreenView);
            fullscreenView = null;
            web.setVisibility(View.VISIBLE);
            if (fullscreenCallback != null) fullscreenCallback.onCustomViewHidden();
            fullscreenCallback = null;
        }

        @Override
        public boolean onConsoleMessage(ConsoleMessage m) {
            Log.d(TAG, m.message() + " (" + m.sourceId() + ":" + m.lineNumber() + ")");
            return true;
        }
    }

    /** What android.js on the page can ask of the phone. */
    class Bridge {
        /** Export: the page's file, saved wherever the reader picks. */
        @JavascriptInterface
        public void saveFile(String name, String mime, String base64) {
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            runOnUiThread(() -> {
                pendingSave = bytes;
                Intent save = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                save.addCategory(Intent.CATEGORY_OPENABLE);
                save.setType(mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
                save.putExtra(Intent.EXTRA_TITLE, name);
                try {
                    startActivityForResult(save, SAVE_FILE);
                } catch (ActivityNotFoundException e) {
                    pendingSave = null;
                    Toast.makeText(MainActivity.this, "Nothing on this phone can save files.", Toast.LENGTH_LONG).show();
                }
            });
        }

        /** The page's background, for the strips behind the system bars. */
        @JavascriptInterface
        public void setBarColor(String css) {
            runOnUiThread(() -> {
                try {
                    int c = Color.parseColor(css);
                    root.setBackgroundColor(c);
                    Window w = getWindow();
                    w.setStatusBarColor(c);
                    w.setNavigationBarColor(c);
                    boolean light = (Color.red(c) * 299 + Color.green(c) * 587 + Color.blue(c) * 114) / 1000 > 140;
                    int flags = w.getDecorView().getSystemUiVisibility();
                    flags = light ? flags | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR : flags & ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                    if (Build.VERSION.SDK_INT >= 26) {
                        flags = light ? flags | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR : flags & ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                    }
                    w.getDecorView().setSystemUiVisibility(flags);
                } catch (IllegalArgumentException ignored) {
                    // Not a colour Android reads; keep the last one.
                }
            });
        }
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        if (request == PICK_FILE) {
            if (pendingPick == null) return;
            Uri[] picked = null;
            if (result == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    picked = new Uri[data.getClipData().getItemCount()];
                    for (int i = 0; i < picked.length; i++) picked[i] = data.getClipData().getItemAt(i).getUri();
                } else if (data.getData() != null) {
                    picked = new Uri[] {data.getData()};
                }
            }
            pendingPick.onReceiveValue(picked);
            pendingPick = null;
        } else if (request == SAVE_FILE) {
            byte[] bytes = pendingSave;
            pendingSave = null;
            if (result != RESULT_OK || data == null || data.getData() == null || bytes == null) return;
            try (OutputStream out = getContentResolver().openOutputStream(data.getData())) {
                out.write(bytes);
                Toast.makeText(this, "Saved.", Toast.LENGTH_SHORT).show();
            } catch (IOException | NullPointerException e) {
                Toast.makeText(this, "Couldn't save the file.", Toast.LENGTH_LONG).show();
            }
        }
    }

    /** Back closes a full-screen video, then whatever the page has open, then leaves. */
    @Override
    public void onBackPressed() {
        goBack();
    }

    void goBack() {
        if (fullscreenView != null) { web.getWebChromeClient().onHideCustomView(); return; }
        web.evaluateJavascript("window.steleAndroidBack ? window.steleAndroidBack() : false", value -> {
            if (!"true".equals(value)) moveTaskToBack(true);
        });
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
