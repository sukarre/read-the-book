package io.github.sukarre.readthebook;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Speaks a list of sentences with Android's text-to-speech engine.
 *
 * Sentences are queued a few ahead inside the engine, so reading keeps going even if the
 * WebView's JavaScript is paused (screen off). All state lives on the main thread.
 */
public class Speaker {
    public interface Listener {
        void onSentence(int index);
        void onRange(int index, int start);
        void onState(boolean playing, int index, int offset);
        void onEnd();
    }

    private static Speaker instance;
    public static synchronized Speaker get(Context ctx) {
        if (instance == null) instance = new Speaker(ctx.getApplicationContext());
        return instance;
    }

    private static final int AHEAD = 3;          // sentences queued in the engine
    private static final long GAP_MS = 140;      // calm pause between sentences

    private final Context ctx;
    private final Handler main = new Handler(Looper.getMainLooper());
    private TextToSpeech tts;
    private boolean ready = false;
    private final List<Runnable> pending = new ArrayList<>();

    private List<String> sentences = new ArrayList<>();
    private int gen = 0;
    private boolean playing = false;
    private int startIndex = 0, startOffset = 0;
    private int current = 0, currentOffset = 0;
    private int nextToQueue = 0;
    private String voiceName = null;
    private float rate = 0.95f, pitch = 1f;
    private String title = "Read the Book";

    private Listener listener;
    private PowerManager.WakeLock wakeLock;
    private AudioFocusRequest focusRequest;

    private Speaker(Context ctx) {
        this.ctx = ctx;
        tts = new TextToSpeech(ctx, status -> main.post(() -> {
            ready = status == TextToSpeech.SUCCESS;
            if (ready) {
                tts.setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build());
                tts.setOnUtteranceProgressListener(progress);
            }
            List<Runnable> run = new ArrayList<>(pending);
            pending.clear();
            for (Runnable r : run) r.run();
        }));
    }

    public void setListener(Listener l) { listener = l; }
    public void onMain(Runnable r) { main.post(r); }
    public boolean isPlaying() { return playing; }
    public String getTitle() { return title; }

    public void setText(List<String> s) {
        stopInternal(false);
        sentences = s;
        current = 0; currentOffset = 0;
    }

    // ---------- Voices ----------
    public interface VoicesCallback { void done(List<Voice> voices, Voice defaultVoice); }

    public void voices(VoicesCallback cb) {
        Runnable r = () -> {
            List<Voice> out = new ArrayList<>();
            Voice def = null;
            if (ready) {
                try {
                    Set<Voice> all = tts.getVoices();
                    if (all != null) for (Voice v : all) {
                        Set<String> f = v.getFeatures();
                        if (f != null && f.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED)) continue;
                        out.add(v);
                    }
                    def = tts.getDefaultVoice();
                } catch (Exception ignored) { }
            }
            cb.done(out, def);
        };
        if (ready) main.post(r); else whenReady(r);
    }

    private void whenReady(Runnable r) {
        // Wait for engine init; give up after 6 seconds so the UI never hangs.
        pending.add(r);
        main.postDelayed(() -> { if (pending.remove(r)) r.run(); }, 6000);
    }

    // ---------- Playback ----------
    public void start(int index, int offset, String voice, float rate, float pitch, String title) {
        main.post(() -> {
            if (!ready) {
                if (tts == null || pending.size() > 4) return;
                whenReady(() -> { if (ready) start(index, offset, voice, rate, pitch, title); });
                return;
            }
            if (sentences.isEmpty()) return;
            this.voiceName = voice; this.rate = rate; this.pitch = pitch;
            if (title != null && !title.isEmpty()) this.title = title;
            begin(index, offset);
        });
    }

    /** Resume from where we stopped (notification Play button). */
    public void resume() {
        main.post(() -> {
            if (!ready || sentences.isEmpty() || playing) return;
            begin(current, currentOffset);
            if (listener != null) listener.onState(true, current, currentOffset);
        });
    }

    private void begin(int index, int offset) {
        gen++;
        tts.stop();
        applyVoice();
        startIndex = Math.max(0, Math.min(index, sentences.size() - 1));
        String s = sentences.get(startIndex);
        startOffset = (offset > 0 && offset < s.length() - 1) ? offset : 0;
        current = startIndex; currentOffset = startOffset;
        nextToQueue = startIndex;
        playing = true;
        acquire();
        ReaderService.update(ctx, true, title);
        for (int k = 0; k <= AHEAD && nextToQueue < sentences.size(); k++) enqueueNext();
    }

    private void applyVoice() {
        tts.setSpeechRate(rate);
        tts.setPitch(pitch);
        if (voiceName == null) return;
        try {
            Set<Voice> all = tts.getVoices();
            if (all != null) for (Voice v : all) {
                if (v.getName().equals(voiceName)) { tts.setVoice(v); return; }
            }
        } catch (Exception ignored) { }
    }

    private void enqueueNext() {
        int i = nextToQueue++;
        String text = sentences.get(i);
        if (i == startIndex && startOffset > 0) text = text.substring(startOffset);
        if (i != startIndex) tts.playSilentUtterance(GAP_MS, TextToSpeech.QUEUE_ADD, "gap:" + gen + ":" + i);
        Bundle params = new Bundle();
        tts.speak(text, TextToSpeech.QUEUE_ADD, params, gen + ":" + i);
    }

    /** Stop speaking and remember the position. Returns {index, offset}. */
    public int[] stop() {
        int[] pos = {current, currentOffset};
        stopInternal(true);
        return pos;
    }

    /** Paused by the notification button or by losing audio focus (a call, another player). */
    public void pauseFromSystem() {
        main.post(() -> {
            if (!playing) return;
            stopInternal(true);
            if (listener != null) listener.onState(false, current, currentOffset);
        });
    }

    private void stopInternal(boolean keepNotification) {
        gen++;
        boolean was = playing;
        playing = false;
        if (ready) tts.stop();
        release();
        if (!keepNotification) ReaderService.dismiss(ctx);
        else if (was) ReaderService.update(ctx, false, title);
    }

    public void preview(String text, String voice, float rate, float pitch) {
        main.post(() -> {
            if (!ready) return;
            stopInternal(true);
            this.voiceName = voice; this.rate = rate; this.pitch = pitch;
            applyVoice();
            tts.speak(text, TextToSpeech.QUEUE_FLUSH, new Bundle(), "preview:" + gen);
        });
    }

    public void shutdownSpeech() {
        main.post(() -> { stopInternal(false); ReaderService.dismiss(ctx); });
    }

    // ---------- Engine callbacks (binder thread → main thread) ----------
    private final UtteranceProgressListener progress = new UtteranceProgressListener() {
        @Override public void onStart(String id) { main.post(() -> started(id)); }
        @Override public void onDone(String id) { main.post(() -> done(id)); }
        @Override @Deprecated public void onError(String id) { main.post(() -> done(id)); }
        @Override public void onError(String id, int code) { main.post(() -> done(id)); }
        @Override public void onRangeStart(String id, int start, int end, int frame) {
            main.post(() -> range(id, start));
        }
    };

    /** Parses "gen:index"; returns -1 for stale or non-sentence utterances. */
    private int indexOf(String id) {
        if (id == null) return -1;
        String[] p = id.split(":");
        if (p.length != 2) return -1;
        try {
            if (Integer.parseInt(p[0]) != gen) return -1;
            return Integer.parseInt(p[1]);
        } catch (NumberFormatException e) { return -1; }
    }

    private int base(int i) { return i == startIndex ? startOffset : 0; }

    private void started(String id) {
        int i = indexOf(id);
        if (i < 0 || !playing) return;
        current = i; currentOffset = base(i);
        if (listener != null) listener.onSentence(i);
    }

    private void range(String id, int start) {
        int i = indexOf(id);
        if (i < 0 || !playing) return;
        currentOffset = base(i) + start;
        if (listener != null) listener.onRange(i, currentOffset);
    }

    private void done(String id) {
        int i = indexOf(id);
        if (i < 0 || !playing) return;
        if (i >= sentences.size() - 1) {
            playing = false;
            gen++;
            current = 0; currentOffset = 0;
            release();
            ReaderService.dismiss(ctx);
            if (listener != null) listener.onEnd();
            return;
        }
        if (nextToQueue < sentences.size()) enqueueNext();
    }

    // ---------- Wake lock and audio focus ----------
    private void acquire() {
        if (wakeLock == null) {
            PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ReadTheBook:reading");
            wakeLock.setReferenceCounted(false);
        }
        wakeLock.acquire(4 * 60 * 60 * 1000L);
        AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            if (focusRequest == null) {
                focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                        .setAudioAttributes(new AudioAttributes.Builder()
                                .setUsage(AudioAttributes.USAGE_MEDIA)
                                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                        .setWillPauseWhenDucked(true)
                        .setOnAudioFocusChangeListener(focusListener, main)
                        .build();
            }
            am.requestAudioFocus(focusRequest);
        } else {
            am.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN);
        }
    }

    private void release() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) { if (focusRequest != null) am.abandonAudioFocusRequest(focusRequest); }
        else am.abandonAudioFocus(focusListener);
    }

    private final AudioManager.OnAudioFocusChangeListener focusListener = change -> {
        if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT
                || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK) {
            pauseFromSystem();
        }
    };

    // ---------- Helpers ----------
    public static String label(Voice v) {
        Locale l = v.getLocale();
        String name = v.getName();
        String code = name;
        int x = name.indexOf("-x-");
        if (x >= 0) {
            code = name.substring(x + 3);
            int dash = code.indexOf('-');
            if (dash > 0) code = code.substring(0, dash);
        }
        String s = l.getDisplayName() + " · " + code;
        if (v.isNetworkConnectionRequired()) s += " · online";
        return s;
    }

    public static List<String> toList(org.json.JSONArray a) {
        List<String> out = new ArrayList<>();
        if (a == null) return Collections.emptyList();
        for (int i = 0; i < a.length(); i++) out.add(a.optString(i, ""));
        return out;
    }
}
