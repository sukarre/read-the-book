package io.github.sukarre.readthebook;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.ServiceCompat;

/**
 * Foreground media service: keeps the app alive while reading with the screen off,
 * and shows a notification with Pause / Play (also on the lock screen).
 */
public class ReaderService extends Service {
    private static final String CHANNEL = "reading";
    private static final int NOTIF_ID = 41;
    static final String ACTION_SHOW = "show";
    static final String ACTION_PAUSE = "pause";
    static final String ACTION_PLAY = "play";
    static final String ACTION_CLOSE = "close";

    /** Called by Speaker whenever playback starts or stops. */
    static void update(Context ctx, boolean playing, String title) {
        if (playing) {
            Intent i = new Intent(ctx, ReaderService.class).setAction(ACTION_SHOW).putExtra("title", title);
            try {
                if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i); else ctx.startService(i);
            } catch (Exception e) {
                // Starting from the background can be refused; speech still plays while the app is open.
            }
        } else {
            // Leave a dismissable notification with a Play button.
            ctx.stopService(new Intent(ctx, ReaderService.class));
            try {
                NotificationManagerCompat.from(ctx).notify(NOTIF_ID, build(ctx, false, title));
            } catch (SecurityException ignored) { }  // notifications not allowed
        }
    }

    static void dismiss(Context ctx) {
        ctx.stopService(new Intent(ctx, ReaderService.class));
        NotificationManagerCompat.from(ctx).cancel(NOTIF_ID);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        Speaker sp = Speaker.get(this);
        if (ACTION_PAUSE.equals(action)) {
            sp.pauseFromSystem();
        } else if (ACTION_PLAY.equals(action)) {
            goForeground(true, sp.getTitle());
            sp.resume();
        } else if (ACTION_CLOSE.equals(action)) {
            sp.pauseFromSystem();
            sp.onMain(() -> dismiss(this));
        } else {
            String title = intent != null ? intent.getStringExtra("title") : null;
            goForeground(true, title != null ? title : sp.getTitle());
        }
        return START_NOT_STICKY;
    }

    private void goForeground(boolean playing, String title) {
        Notification n = build(this, playing, title);
        int type = Build.VERSION.SDK_INT >= 29 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK : 0;
        ServiceCompat.startForeground(this, NOTIF_ID, n, type);
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // App swiped away: stop reading.
        Speaker.get(this).shutdownSpeech();
        stopSelf();
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    private static Notification build(Context ctx, boolean playing, String title) {
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Reading aloud", NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            nm.createNotificationChannel(ch);
        }
        int imm = PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT;
        Intent open = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
        PendingIntent content = PendingIntent.getActivity(ctx, 0, open, imm);

        PendingIntent toggle;
        if (playing) {
            toggle = PendingIntent.getService(ctx, 1, new Intent(ctx, ReaderService.class).setAction(ACTION_PAUSE), imm);
        } else {
            Intent play = new Intent(ctx, ReaderService.class).setAction(ACTION_PLAY);
            toggle = Build.VERSION.SDK_INT >= 26
                    ? PendingIntent.getForegroundService(ctx, 2, play, imm)
                    : PendingIntent.getService(ctx, 2, play, imm);
        }
        PendingIntent close = PendingIntent.getService(ctx, 3, new Intent(ctx, ReaderService.class).setAction(ACTION_CLOSE), imm);

        return new NotificationCompat.Builder(ctx, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_read)
                .setContentTitle(title != null ? title : "Read the Book")
                .setContentText(playing ? "Reading aloud" : "Paused")
                .setContentIntent(content)
                .setOngoing(playing)
                .setOnlyAlertOnce(true)
                .setSilent(true)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
                .addAction(playing ? R.drawable.ic_pause : R.drawable.ic_play, playing ? "Pause" : "Play", toggle)
                .addAction(R.drawable.ic_close, "Stop", close)
                .build();
    }
}
