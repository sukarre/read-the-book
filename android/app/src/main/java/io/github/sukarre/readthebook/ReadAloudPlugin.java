package io.github.sukarre.readthebook;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.speech.tts.Voice;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.List;

/** Bridge between the web app (native.js) and Speaker / ReaderService. */
@CapacitorPlugin(name = "ReadAloud")
public class ReadAloudPlugin extends Plugin implements Speaker.Listener {
    private Speaker speaker;
    private boolean askedNotifications = false;

    @Override
    public void load() {
        speaker = Speaker.get(getContext());
        speaker.setListener(this);
    }

    @PluginMethod
    public void getVoices(PluginCall call) {
        speaker.voices((voices, def) -> {
            JSArray arr = new JSArray();
            for (Voice v : voices) {
                JSObject o = new JSObject();
                o.put("voiceURI", v.getName());
                o.put("name", Speaker.label(v));
                o.put("lang", v.getLocale().toLanguageTag());
                o.put("quality", v.getQuality());
                o.put("network", v.isNetworkConnectionRequired());
                o.put("localService", !v.isNetworkConnectionRequired());
                o.put("default", def != null && def.getName().equals(v.getName()));
                arr.put(o);
            }
            JSObject r = new JSObject();
            r.put("voices", arr);
            call.resolve(r);
        });
    }

    @PluginMethod
    public void setText(PluginCall call) {
        List<String> list = Speaker.toList(call.getArray("sentences", new JSArray()));
        speaker.onMain(() -> { speaker.setText(list); call.resolve(); });
    }

    @PluginMethod
    public void start(PluginCall call) {
        askNotificationPermission();
        speaker.start(
                call.getInt("index", 0), call.getInt("offset", 0),
                call.getString("voice", null),
                call.getFloat("rate", 0.95f), call.getFloat("pitch", 1f),
                call.getString("title", null));
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        speaker.onMain(() -> {
            int[] pos = speaker.stop();
            JSObject r = new JSObject();
            r.put("index", pos[0]);
            r.put("offset", pos[1]);
            call.resolve(r);
        });
    }

    @PluginMethod
    public void preview(PluginCall call) {
        speaker.preview(call.getString("text", "Hello."), call.getString("voice", null),
                call.getFloat("rate", 0.95f), call.getFloat("pitch", 1f));
        call.resolve();
    }

    @PluginMethod
    public void openTtsSettings(PluginCall call) {
        try {
            getContext().startActivity(new Intent("com.android.settings.TTS_SETTINGS").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (Exception e) {
            getContext().startActivity(new Intent(android.provider.Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        }
        call.resolve();
    }

    /** Android 13+: the Pause/Play notification needs permission (asked once, on first play). */
    private void askNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33 || askedNotifications || getActivity() == null) return;
        askedNotifications = true;
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(getActivity(), new String[]{Manifest.permission.POST_NOTIFICATIONS}, 4101);
        }
    }

    // ---------- Speaker events -> JavaScript ----------
    @Override public void onSentence(int index) {
        JSObject o = new JSObject(); o.put("index", index); notifyListeners("sentence", o);
    }
    @Override public void onRange(int index, int start) {
        JSObject o = new JSObject(); o.put("index", index); o.put("start", start); notifyListeners("range", o);
    }
    @Override public void onState(boolean playing, int index, int offset) {
        JSObject o = new JSObject(); o.put("playing", playing); o.put("index", index); o.put("offset", offset);
        notifyListeners("state", o);
    }
    @Override public void onEnd() { notifyListeners("end", new JSObject()); }
}
