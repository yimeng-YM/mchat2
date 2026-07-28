package com.mchat2;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.provider.Settings;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.speech.RecognizerIntent;

import androidx.activity.result.ActivityResult;
import androidx.core.app.NotificationCompat;
import androidx.core.app.Person;
import androidx.core.graphics.drawable.IconCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.ArrayList;
import android.util.Base64;
import java.util.Locale;
import java.util.UUID;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(
    name = "DeviceFeatures",
    permissions = {
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class DeviceFeaturesPlugin extends Plugin {
    private static final String NOTIFICATION_CHANNEL = "mchat2_replies";
    private static final String NOTIFICATION_ROLE_EXTRA = "mchat2.notification.roleId";
    private static final String SECRET_KEY_ALIAS = "mchat2.secure.settings";
    private static final String SECRET_PREFERENCES = "mchat2_secure";

    @PluginMethod
    public void pickImage(PluginCall call) {
        Intent intent;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent = new Intent(MediaStore.ACTION_PICK_IMAGES);
            intent.setType("image/*");
        } else {
            intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("image/*");
        }
        startActivityForResult(call, intent, "pickImageResult");
    }

    @PluginMethod
    public void readImageDataUrl(PluginCall call) {
        String rawUri = call.getString("uri", "");
        int maxDimension = call.getInt("maxDimension", 1600);
        int quality = call.getInt("quality", 82);
        new Thread(() -> {
            try {
                File file = new File(Uri.parse(rawUri).getPath());
                File attachmentRoot = new File(getContext().getFilesDir(), "chat-attachments").getCanonicalFile();
                File resolved = file.getCanonicalFile();
                if (!resolved.getPath().startsWith(attachmentRoot.getPath() + File.separator)) {
                    throw new SecurityException("图片不在附件目录中");
                }
                Bitmap bitmap = decodeScaledBitmap(resolved, Math.max(320, maxDimension));
                if (bitmap == null) throw new IllegalStateException("无法解析图片");
                ByteArrayOutputStream output = new ByteArrayOutputStream();
                bitmap.compress(Bitmap.CompressFormat.JPEG, Math.max(40, Math.min(95, quality)), output);
                bitmap.recycle();
                JSObject response = new JSObject();
                response.put("dataUrl", "data:image/jpeg;base64," + Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP));
                call.resolve(response);
            } catch (Exception error) {
                call.reject("无法准备发送图片", error);
            }
        }).start();
    }

    @ActivityCallback
    private void pickImageResult(PluginCall call, ActivityResult result) {
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            JSObject response = new JSObject();
            response.put("cancelled", true);
            call.resolve(response);
            return;
        }
        long roleId = call.getLong("roleId", 0L);

        Uri source = result.getData().getData();
        getBridge().executeOnMainThread(() -> new Thread(() -> {
            try {
                ContentResolver resolver = getContext().getContentResolver();
                String name = displayName(resolver, source);
                String mime = resolver.getType(source);
                if (mime == null) mime = "image/jpeg";
                File directory = new File(getContext().getFilesDir(), "chat-attachments/" + roleId);
                if (!directory.exists() && !directory.mkdirs()) throw new IllegalStateException("无法创建附件目录");
                String safeName = name.replaceAll("[^\\p{L}\\p{N}._-]", "_");
                if (safeName.length() > 100) safeName = safeName.substring(safeName.length() - 100);
                File destination = new File(directory, UUID.randomUUID() + "--" + safeName);
                try (InputStream input = resolver.openInputStream(source); FileOutputStream output = new FileOutputStream(destination)) {
                    if (input == null) throw new IllegalStateException("无法读取图片");
                    byte[] buffer = new byte[1024 * 1024];
                    int read;
                    while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
                }
                JSObject response = new JSObject();
                response.put("id", destination.getName());
                response.put("kind", "image");
                response.put("name", name);
                response.put("mime", mime);
                response.put("size", destination.length());
                response.put("uri", Uri.fromFile(destination).toString());
                call.resolve(response);
            } catch (Exception error) {
                call.reject("导入图片失败", error);
            }
        }).start());
    }

    @PluginMethod
    public void startSpeech(PluginCall call) {
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.SIMPLIFIED_CHINESE.toLanguageTag());
        intent.putExtra(RecognizerIntent.EXTRA_PROMPT, "请说话");
        try {
            startActivityForResult(call, intent, "speechResult");
        } catch (Exception error) {
            call.reject("当前设备没有可用的语音识别服务", error);
        }
    }

    @ActivityCallback
    private void speechResult(PluginCall call, ActivityResult result) {
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            JSObject response = new JSObject();
            response.put("cancelled", true);
            call.resolve(response);
            return;
        }
        ArrayList<String> matches = result.getData().getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
        JSObject response = new JSObject();
        response.put("text", matches == null || matches.isEmpty() ? "" : matches.get(0));
        call.resolve(response);
    }

    @PluginMethod
    public void requestNotifications(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || getPermissionState("notifications") == PermissionState.GRANTED) {
            JSObject response = new JSObject();
            response.put("granted", true);
            call.resolve(response);
            return;
        }
        requestPermissionForAlias("notifications", call, "notificationPermissionResult");
    }

    @PluginMethod
    public void checkNotifications(PluginCall call) {
        JSObject response = new JSObject();
        response.put(
            "granted",
            Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
                || getPermissionState("notifications") == PermissionState.GRANTED
        );
        call.resolve(response);
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
        intent.setData(Uri.fromParts("package", getContext().getPackageName(), null));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    @PermissionCallback
    private void notificationPermissionResult(PluginCall call) {
        JSObject response = new JSObject();
        response.put("granted", getPermissionState("notifications") == PermissionState.GRANTED);
        call.resolve(response);
    }

    // 由 roleId 生成稳定的通知 id，使同一角色的通知可被后续查看操作精准清除。
    private static int notificationId(long roleId) {
        return (int) ((roleId ^ (roleId >>> 32)) & 0x7fffffff);
    }

    @PluginMethod
    public void clearNotifications(PluginCall call) {
        NotificationManager manager = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) {
            call.resolve();
            return;
        }
        Long roleId = call.getLong("roleId");
        if (roleId == null) manager.cancelAll();
        else manager.cancel(notificationId(roleId));
        call.resolve();
    }

    @PluginMethod
    public void notify(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && getPermissionState("notifications") != PermissionState.GRANTED) {
            call.reject("通知权限尚未开启");
            return;
        }
        NotificationManager manager = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) {
            call.reject("系统通知服务不可用");
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(NOTIFICATION_CHANNEL, "角色回复", NotificationManager.IMPORTANCE_DEFAULT);
            channel.setDescription("角色完成回复时的本地提醒");
            manager.createNotificationChannel(channel);
        }
        long roleId = call.getLong("roleId", 0L);
        Intent launch = new Intent(getContext(), MainActivity.class);
        launch.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        launch.putExtra(NOTIFICATION_ROLE_EXTRA, roleId);
        PendingIntent pendingIntent = PendingIntent.getActivity(
            getContext(),
            notificationId(roleId),
            launch,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        NotificationCompat.Builder notification = new NotificationCompat.Builder(getContext(), NOTIFICATION_CHANNEL)
            .setSmallIcon(android.R.drawable.ic_dialog_email)
            .setContentTitle(call.getString("title", "MChat2"))
            .setContentText(call.getString("body", "收到一条新消息"))
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT);
        String avatarDataUrl = call.getString("avatarDataUrl");
        Bitmap avatar = decodeDataUrlBitmap(avatarDataUrl);
        if (avatar != null) {
            String title = call.getString("title", "MChat2");
            String body = call.getString("body", "收到一条新消息");
            Person user = new Person.Builder().setName("你").build();
            Person sender = new Person.Builder()
                .setName(title)
                .setIcon(IconCompat.createWithBitmap(avatar))
                .build();
            notification
                .setLargeIcon(avatar)
                .setStyle(new NotificationCompat.MessagingStyle(user).addMessage(body, System.currentTimeMillis(), sender));
        } else {
            notification.setStyle(new NotificationCompat.BigTextStyle().bigText(call.getString("body", "收到一条新消息")));
        }
        manager.notify(notificationId(roleId), notification.build());
        call.resolve();
    }

    @PluginMethod
    public void getPendingNotificationOpen(PluginCall call) {
        JSObject response = new JSObject();
        Intent intent = getActivity() == null ? null : getActivity().getIntent();
        long roleId = consumeNotificationRoleId(intent);
        if (roleId > 0) response.put("roleId", roleId);
        call.resolve(response);
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (getActivity() != null) getActivity().setIntent(intent);
        long roleId = consumeNotificationRoleId(intent);
        if (roleId <= 0) return;
        JSObject payload = new JSObject();
        payload.put("roleId", roleId);
        notifyListeners("notificationOpened", payload, true);
    }

    private long consumeNotificationRoleId(Intent intent) {
        if (intent == null || !intent.hasExtra(NOTIFICATION_ROLE_EXTRA)) return 0L;
        long roleId = intent.getLongExtra(NOTIFICATION_ROLE_EXTRA, 0L);
        intent.removeExtra(NOTIFICATION_ROLE_EXTRA);
        return roleId;
    }

    @PluginMethod
    public void saveSecret(PluginCall call) {
        String key = normalizedSecretKey(call.getString("key", ""));
        String value = call.getString("value", "");
        if (key == null) {
            call.reject("无效的安全存储键");
            return;
        }
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, secureStorageKey());
            byte[] encrypted = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
            String encoded = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP)
                + ":"
                + Base64.encodeToString(encrypted, Base64.NO_WRAP);
            securePreferences().edit().putString(key, encoded).apply();
            call.resolve();
        } catch (Exception error) {
            call.reject("无法保存安全设置", error);
        }
    }

    @PluginMethod
    public void loadSecret(PluginCall call) {
        String key = normalizedSecretKey(call.getString("key", ""));
        if (key == null) {
            call.reject("无效的安全存储键");
            return;
        }
        String encoded = securePreferences().getString(key, null);
        JSObject response = new JSObject();
        if (encoded == null || encoded.isEmpty()) {
            call.resolve(response);
            return;
        }
        try {
            String[] parts = encoded.split(":", 2);
            if (parts.length != 2) throw new IllegalStateException("安全设置格式损坏");
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(
                Cipher.DECRYPT_MODE,
                secureStorageKey(),
                new GCMParameterSpec(128, Base64.decode(parts[0], Base64.DEFAULT))
            );
            byte[] plain = cipher.doFinal(Base64.decode(parts[1], Base64.DEFAULT));
            response.put("value", new String(plain, StandardCharsets.UTF_8));
            call.resolve(response);
        } catch (Exception error) {
            call.reject("无法读取安全设置", error);
        }
    }

    @PluginMethod
    public void clearSecret(PluginCall call) {
        String key = normalizedSecretKey(call.getString("key", ""));
        if (key == null) {
            call.reject("无效的安全存储键");
            return;
        }
        securePreferences().edit().remove(key).apply();
        call.resolve();
    }

    private String normalizedSecretKey(String key) {
        String normalized = key == null ? "" : key.trim();
        return normalized.matches("[A-Za-z0-9._-]{1,80}") ? normalized : null;
    }

    private SharedPreferences securePreferences() {
        return getContext().getSharedPreferences(SECRET_PREFERENCES, Context.MODE_PRIVATE);
    }

    private SecretKey secureStorageKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        java.security.Key existing = keyStore.getKey(SECRET_KEY_ALIAS, null);
        if (existing instanceof SecretKey) return (SecretKey) existing;
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(
            SECRET_KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .build());
        return generator.generateKey();
    }

    @PluginMethod
    public void removeRoleFiles(PluginCall call) {
        long roleId = call.getLong("roleId", 0L);
        File directory = new File(getContext().getFilesDir(), "chat-attachments/" + roleId);
        deleteRecursively(directory);
        call.resolve();
    }

    private String displayName(ContentResolver resolver, Uri uri) {
        try (Cursor cursor = resolver.query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (index >= 0) return cursor.getString(index);
            }
        }
        String segment = uri.getLastPathSegment();
        return segment == null ? "attachment" : segment;
    }

    private Bitmap decodeScaledBitmap(File file, int maxDimension) {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(file.getAbsolutePath(), bounds);
        int sample = 1;
        while (Math.max(bounds.outWidth / sample, bounds.outHeight / sample) > maxDimension * 2) sample *= 2;
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inSampleSize = sample;
        Bitmap decoded = BitmapFactory.decodeFile(file.getAbsolutePath(), options);
        if (decoded == null) return null;
        int largest = Math.max(decoded.getWidth(), decoded.getHeight());
        if (largest <= maxDimension) return decoded;
        float scale = maxDimension / (float) largest;
        Bitmap scaled = Bitmap.createScaledBitmap(
            decoded,
            Math.max(1, Math.round(decoded.getWidth() * scale)),
            Math.max(1, Math.round(decoded.getHeight() * scale)),
            true
        );
        if (scaled != decoded) decoded.recycle();
        return scaled;
    }

    private Bitmap decodeDataUrlBitmap(String dataUrl) {
        if (dataUrl == null) return null;
        int comma = dataUrl.indexOf(',');
        if (comma < 0) return null;
        try {
            byte[] bytes = Base64.decode(dataUrl.substring(comma + 1), Base64.DEFAULT);
            return BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
        } catch (Exception ignored) {
            return null;
        }
    }

    private void deleteRecursively(File target) {
        if (!target.exists()) return;
        if (target.isDirectory()) {
            File[] children = target.listFiles();
            if (children != null) for (File child : children) deleteRecursively(child);
        }
        target.delete();
    }
}
