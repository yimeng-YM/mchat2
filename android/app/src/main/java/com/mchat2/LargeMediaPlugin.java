package com.mchat2;

import android.app.Activity;
import android.content.ClipData;
import android.content.ContentValues;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.net.Uri;
import android.provider.OpenableColumns;

import androidx.activity.result.ActivityResult;

import org.json.JSONObject;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;

@CapacitorPlugin(name = "LargeMedia")
public class LargeMediaPlugin extends Plugin {
    private static final int MAX_ZIP_ENTRIES = 50_000;
    private static final long MAX_BACKUP_EXTRACTED_BYTES = 2L * 1024 * 1024 * 1024;
    private static final long MAX_ARCHIVE_ENTRY_BYTES = 512L * 1024 * 1024;
    private static final long MAX_MEDIA_ENTRY_BYTES = 128L * 1024 * 1024;
    private static final long MAX_MANIFEST_BYTES = 256L * 1024;
    private final ExecutorService ioExecutor = Executors.newSingleThreadExecutor();
    private final Map<String, File> pendingTextExports = new ConcurrentHashMap<>();
    private MediaDatabase mediaDatabase;

    @Override
    public void load() {
        mediaDatabase = new MediaDatabase();
    }

    @PluginMethod
    public void pickAndImport(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
            "image/png", "image/jpeg", "image/gif", "image/webp",
            "application/zip", "application/x-zip-compressed"
        });
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        startActivityForResult(call, intent, "pickAndImportResult");
    }

    @ActivityCallback
    private void pickAndImportResult(PluginCall call, ActivityResult result) {
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            JSObject response = new JSObject();
            response.put("imported", 0);
            response.put("failed", 0);
            call.resolve(response);
            return;
        }

        long roleId = call.getLong("roleId", 0L);
        if (roleId <= 0) {
            call.reject("无效的角色 ID");
            return;
        }

        Intent data = result.getData();
        List<Uri> uris = new ArrayList<>();
        ClipData clipData = data.getClipData();
        if (clipData != null) {
            for (int index = 0; index < clipData.getItemCount(); index++) uris.add(clipData.getItemAt(index).getUri());
        } else if (data.getData() != null) {
            uris.add(data.getData());
        }

        ioExecutor.execute(() -> {
            int imported = 0;
            int failed = 0;
            String firstError = null;
            File directory = roleDirectory(roleId);
            if (!directory.exists() && !directory.mkdirs()) {
                call.reject("无法创建角色表情包目录");
                return;
            }

            SQLiteDatabase importDatabase = mediaDatabase.getWritableDatabase();
            importDatabase.beginTransaction();
            try {
                for (Uri uri : uris) {
                    try {
                        String displayName = displayName(getContext().getContentResolver(), uri);
                        String mime = getContext().getContentResolver().getType(uri);
                        if (isZip(displayName, mime)) {
                            int zipImported = importZipIntoLibrary(uri, directory, roleId);
                            imported += zipImported;
                            if (zipImported == 0) failed += 1;
                        } else if (isSupportedImage(displayName, mime)) {
                            File storedFile = copyIntoLibrary(uri, directory, displayName);
                            mediaDatabase.insert(storedFile, roleId, nameWithoutExtension(displayName), mimeFromName(displayName));
                            imported += 1;
                        } else {
                            failed += 1;
                        }
                    } catch (Exception error) {
                        failed += 1;
                        if (firstError == null) firstError = error.getMessage();
                    }
                    JSObject progress = new JSObject();
                    progress.put("processed", imported + failed);
                    progress.put("total", uris.size());
                    notifyListeners("importProgress", progress);
                }
                importDatabase.setTransactionSuccessful();
            } finally {
                importDatabase.endTransaction();
            }

            JSObject response = new JSObject();
            response.put("imported", imported);
            response.put("failed", failed);
            if (firstError != null) response.put("message", firstError);
            call.resolve(response);
        });
    }

    @PluginMethod
    public void list(PluginCall call) {
        long roleId = call.getLong("roleId", 0L);
        int offset = Math.max(0, call.getInt("offset", 0));
        int limit = Math.min(200, Math.max(1, call.getInt("limit", 60)));
        ioExecutor.execute(() -> {
            call.resolve(mediaDatabase.list(roleId, offset, limit));
        });
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String rawUri = call.getString("uri", "");
        ioExecutor.execute(() -> {
            try {
                File root = mediaRoot().getCanonicalFile();
                File target = new File(Uri.parse(rawUri).getPath()).getCanonicalFile();
                boolean insideLibrary = target.getPath().startsWith(root.getPath() + File.separator);
                JSObject response = new JSObject();
                boolean removed = insideLibrary && target.isFile() && target.delete();
                if (removed) mediaDatabase.remove(target.getPath());
                response.put("removed", removed);
                call.resolve(response);
            } catch (Exception error) {
                call.reject("删除文件失败", error);
            }
        });
    }

    @PluginMethod
    public void rename(PluginCall call) {
        String rawUri = call.getString("uri", "");
        String name = call.getString("name", "").trim();
        if (name.isEmpty()) { call.reject("表情名称不能为空"); return; }
        ioExecutor.execute(() -> {
            try {
                File root = mediaRoot().getCanonicalFile();
                File target = new File(Uri.parse(rawUri).getPath()).getCanonicalFile();
                boolean insideLibrary = target.getPath().startsWith(root.getPath() + File.separator);
                if (!insideLibrary || !target.isFile()) { call.reject("无效的表情文件"); return; }
                mediaDatabase.rename(target.getPath(), name);
                JSObject response = new JSObject();
                response.put("renamed", true);
                call.resolve(response);
            } catch (Exception error) {
                call.reject("重命名表情失败", error);
            }
        });
    }

    @PluginMethod
    public void stats(PluginCall call) {
        ioExecutor.execute(() -> {
            call.resolve(mediaDatabase.stats());
        });
    }

    @PluginMethod
    public void removeRole(PluginCall call) {
        long roleId = call.getLong("roleId", 0L);
        ioExecutor.execute(() -> {
            deleteRecursively(roleDirectory(roleId));
            mediaDatabase.removeRole(roleId);
            call.resolve();
        });
    }

    @PluginMethod
    public void beginTextExport(PluginCall call) {
        ioExecutor.execute(() -> {
            try {
                File directory = new File(getContext().getCacheDir(), "exports");
                if (!directory.exists() && !directory.mkdirs()) throw new IllegalStateException("无法创建导出目录");
                String token = UUID.randomUUID().toString();
                File file = new File(directory, token + ".ndjson");
                if (!file.createNewFile()) throw new IllegalStateException("无法创建导出文件");
                pendingTextExports.put(token, file);
                JSObject response = new JSObject();
                response.put("token", token);
                call.resolve(response);
            } catch (Exception error) {
                call.reject("无法开始导出", error);
            }
        });
    }

    @PluginMethod
    public void appendTextExport(PluginCall call) {
        String token = call.getString("token", "");
        String chunk = call.getString("chunk", "");
        ioExecutor.execute(() -> {
            File file = pendingTextExports.get(token);
            if (file == null) { call.reject("导出任务已失效"); return; }
            try (FileOutputStream output = new FileOutputStream(file, true)) {
                output.write(chunk.getBytes(StandardCharsets.UTF_8));
                call.resolve();
            } catch (Exception error) {
                call.reject("写入导出文件失败", error);
            }
        });
    }

    @PluginMethod
    public void saveTextExport(PluginCall call) {
        String token = call.getString("token", "");
        if (!pendingTextExports.containsKey(token)) { call.reject("导出任务已失效"); return; }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/x-ndjson");
        intent.putExtra(Intent.EXTRA_TITLE, call.getString("name", "mchat2-conversations.ndjson"));
        startActivityForResult(call, intent, "saveTextExportResult");
    }

    @ActivityCallback
    private void saveTextExportResult(PluginCall call, ActivityResult result) {
        String token = call.getString("token", "");
        File source = pendingTextExports.remove(token);
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            if (source != null) source.delete();
            JSObject response = new JSObject(); response.put("saved", false); call.resolve(response); return;
        }
        Uri destination = result.getData().getData();
        ioExecutor.execute(() -> {
            try {
                if (source == null) throw new IllegalStateException("临时归档不存在");
                try (InputStream input = new FileInputStream(source); OutputStream output = getContext().getContentResolver().openOutputStream(destination)) {
                    if (output == null) throw new IllegalStateException("无法打开保存位置");
                    copyStream(input, output);
                }
                source.delete();
                JSObject response = new JSObject(); response.put("saved", true); call.resolve(response);
            } catch (Exception error) {
                call.reject("保存归档失败", error);
            }
        });
    }

    @PluginMethod
    public void exportRolePack(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/zip");
        intent.putExtra(Intent.EXTRA_TITLE, call.getString("name", "emoji-pack.zip"));
        startActivityForResult(call, intent, "exportRolePackResult");
    }

    @ActivityCallback
    private void exportRolePackResult(PluginCall call, ActivityResult result) {
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            JSObject response = new JSObject(); response.put("saved", false); response.put("exported", 0); call.resolve(response); return;
        }
        long roleId = call.getLong("roleId", 0L);
        Uri destination = result.getData().getData();
        ioExecutor.execute(() -> {
            try {
                int exported = mediaDatabase.exportZip(roleId, destination);
                JSObject response = new JSObject(); response.put("saved", true); response.put("exported", exported); call.resolve(response);
            } catch (Exception error) {
                call.reject("导出表情包失败", error);
            }
        });
    }

    // 完整备份：把已写好的对话/记忆临时文件（convToken/memToken）与表情原文件流式打进一个 zip。
    @PluginMethod
    public void assembleBackup(PluginCall call) {
        String convToken = call.getString("convToken", "");
        String memToken = call.getString("memToken", "");
        String assetToken = call.getString("assetToken", "");
        if (!pendingTextExports.containsKey(convToken) || !pendingTextExports.containsKey(memToken)
            || !pendingTextExports.containsKey(assetToken)) {
            call.reject("备份数据已失效，请重试");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/zip");
        intent.putExtra(Intent.EXTRA_TITLE, call.getString("name", "MChat2-backup.zip"));
        startActivityForResult(call, intent, "assembleBackupResult");
    }

    @ActivityCallback
    private void assembleBackupResult(PluginCall call, ActivityResult result) {
        String convToken = call.getString("convToken", "");
        String memToken = call.getString("memToken", "");
        String assetToken = call.getString("assetToken", "");
        File conversations = pendingTextExports.remove(convToken);
        File memories = pendingTextExports.remove(memToken);
        File assets = pendingTextExports.remove(assetToken);
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            if (conversations != null) conversations.delete();
            if (memories != null) memories.delete();
            if (assets != null) assets.delete();
            JSObject response = new JSObject();
            response.put("saved", false);
            response.put("emojis", 0);
            response.put("attachments", 0);
            call.resolve(response);
            return;
        }
        String manifest = call.getString("manifest", "{}");
        Set<Long> roleFilter = parseRoleFilter(call.getArray("roleIds", null));
        Uri destination = result.getData().getData();
        ioExecutor.execute(() -> {
            try {
                if (conversations == null || memories == null || assets == null) throw new IllegalStateException("备份临时文件缺失");
                OutputStream rawOutput = getContext().getContentResolver().openOutputStream(destination);
                if (rawOutput == null) throw new IllegalStateException("无法打开保存位置");
                int emojis;
                int attachments;
                try (ZipOutputStream zip = new ZipOutputStream(rawOutput)) {
                    writeZipText(zip, "manifest.json", manifest);
                    writeZipFile(zip, "conversations.ndjson", conversations);
                    writeZipFile(zip, "memories.ndjson", memories);
                    writeZipFile(zip, "assets.ndjson", assets);
                    emojis = mediaDatabase.exportBackup(zip, roleFilter);
                    attachments = exportChatAttachments(zip, roleFilter);
                }
                JSObject response = new JSObject();
                response.put("saved", true);
                response.put("emojis", emojis);
                response.put("attachments", attachments);
                call.resolve(response);
            } catch (Exception error) {
                call.reject("生成备份失败", error);
            } finally {
                if (conversations != null) conversations.delete();
                if (memories != null) memories.delete();
                if (assets != null) assets.delete();
            }
        });
    }

    // 完整恢复：选一个备份 zip，流式解压——对话/记忆写到 cache 供 WebView 读取，表情原文件落回表情库目录。
    @PluginMethod
    public void pickBackup(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"application/zip", "application/x-zip-compressed", "application/octet-stream"});
        startActivityForResult(call, intent, "pickBackupResult");
    }

    @ActivityCallback
    private void pickBackupResult(PluginCall call, ActivityResult result) {
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            JSObject response = new JSObject(); response.put("restored", false); call.resolve(response);
            return;
        }
        Uri source = result.getData().getData();
        ioExecutor.execute(() -> {
            try {
                File workDir = new File(getContext().getCacheDir(), "restore");
                deleteRecursively(workDir);
                if (!workDir.mkdirs()) throw new IllegalStateException("无法创建恢复目录");
                File conversations = new File(workDir, "conversations.ndjson");
                File memories = new File(workDir, "memories.ndjson");
                File assets = new File(workDir, "assets.ndjson");
                Map<String, JSONObject> emojiMeta = new HashMap<>();
                List<String[]> stagedEmojis = new ArrayList<>(); // {roleId, fileId, path}
                List<String[]> stagedAttachments = new ArrayList<>(); // {roleId, fileId, path}
                ExtractionBudget budget = new ExtractionBudget();
                String manifest = null;

                InputStream rawInput = getContext().getContentResolver().openInputStream(source);
                if (rawInput == null) throw new IllegalStateException("无法读取备份文件");
                try (ZipInputStream zip = new ZipInputStream(rawInput)) {
                    ZipEntry entry;
                    byte[] buffer = new byte[1024 * 1024];
                    while ((entry = zip.getNextEntry()) != null) {
                        budget.entries += 1;
                        if (budget.entries > MAX_ZIP_ENTRIES) throw new IllegalStateException("备份文件条目数超过安全限制");
                        String entryName = entry.getName();
                        if (entry.isDirectory()) { zip.closeEntry(); continue; }
                        if ("manifest.json".equals(entryName)) {
                            manifest = readZipText(zip, budget, MAX_MANIFEST_BYTES);
                        } else if ("conversations.ndjson".equals(entryName)) {
                            writeStreamToFile(zip, conversations, buffer, budget, MAX_ARCHIVE_ENTRY_BYTES);
                        } else if ("memories.ndjson".equals(entryName)) {
                            writeStreamToFile(zip, memories, buffer, budget, MAX_ARCHIVE_ENTRY_BYTES);
                        } else if ("assets.ndjson".equals(entryName)) {
                            writeStreamToFile(zip, assets, buffer, budget, MAX_ARCHIVE_ENTRY_BYTES);
                        } else if ("emoji-index.ndjson".equals(entryName)) {
                            readEmojiIndex(zip, emojiMeta, budget);
                        } else if (entryName.startsWith("emoji/")) {
                            // emoji/<roleId>/<fileId>
                            String[] parts = entryName.split("/");
                            if (parts.length != 3 || parts[1].isEmpty() || parts[2].isEmpty()) { zip.closeEntry(); continue; }
                            long roleId;
                            try { roleId = Long.parseLong(parts[1]); } catch (NumberFormatException nfe) { zip.closeEntry(); continue; }
                            if (roleId <= 0 || !safeArchiveFileName(parts[2])) { zip.closeEntry(); continue; }
                            File directory = new File(workDir, "emoji-stage/" + roleId);
                            if (!directory.exists() && !directory.mkdirs()) { zip.closeEntry(); continue; }
                            File target = safeArchiveTarget(directory, parts[2]);
                            writeStreamToFile(zip, target, buffer, budget, MAX_MEDIA_ENTRY_BYTES);
                            stagedEmojis.add(new String[]{parts[1], parts[2], target.getAbsolutePath()});
                        } else if (entryName.startsWith("attachments/")) {
                            String[] parts = entryName.split("/");
                            if (parts.length != 3 || !safeArchiveFileName(parts[2])) { zip.closeEntry(); continue; }
                            long roleId;
                            try { roleId = Long.parseLong(parts[1]); } catch (NumberFormatException nfe) { zip.closeEntry(); continue; }
                            if (roleId <= 0) { zip.closeEntry(); continue; }
                            File directory = new File(workDir, "attachment-stage/" + roleId);
                            if (!directory.exists() && !directory.mkdirs()) throw new IllegalStateException("无法创建附件恢复目录");
                            File target = safeArchiveTarget(directory, parts[2]);
                            writeStreamToFile(zip, target, buffer, budget, MAX_MEDIA_ENTRY_BYTES);
                            stagedAttachments.add(new String[]{parts[1], parts[2], target.getAbsolutePath()});
                        }
                        zip.closeEntry();
                    }
                }

                if (manifest == null) throw new IllegalStateException("备份缺少 manifest.json");
                JSONObject manifestObject = new JSONObject(manifest);
                int version = manifestObject.optInt("version", 0);
                if (!"mchat2-full-backup".equals(manifestObject.optString("type")) || (version != 1 && version != 2)) {
                    throw new IllegalStateException("备份清单格式或版本不受支持");
                }
                commitStagedFiles(stagedEmojis, mediaRoot());
                File attachmentRoot = new File(getContext().getFilesDir(), "chat-attachments");
                commitStagedFiles(stagedAttachments, attachmentRoot);
                int restoredEmojis = mediaDatabase.restoreEmojis(stagedEmojis, emojiMeta);
                int restoredAttachments = stagedAttachments.size();
                JSObject response = new JSObject();
                response.put("restored", true);
                // 返回 file:// URI，供 JS 端 Capacitor.convertFileSrc 转成 WebView 可 fetch 的地址。
                response.put("conversationsPath", conversations.isFile() ? Uri.fromFile(conversations).toString() : "");
                response.put("memoriesPath", memories.isFile() ? Uri.fromFile(memories).toString() : "");
                response.put("assetsPath", assets.isFile() ? Uri.fromFile(assets).toString() : "");
                response.put("attachmentRootUri", Uri.fromFile(attachmentRoot).toString());
                response.put("manifest", manifest);
                response.put("emojis", restoredEmojis);
                response.put("attachments", restoredAttachments);
                call.resolve(response);
            } catch (Exception error) {
                call.reject("恢复备份失败", error);
            }
        });
    }

    private Set<Long> parseRoleFilter(JSArray roleIds) {
        if (roleIds == null) return null;
        Set<Long> filter = new HashSet<>();
        for (int index = 0; index < roleIds.length(); index++) {
            long id = roleIds.optLong(index, 0L);
            if (id > 0) filter.add(id);
        }
        return filter.isEmpty() ? null : filter;
    }

    private void writeZipText(ZipOutputStream zip, String name, String content) throws Exception {
        zip.putNextEntry(new ZipEntry(name));
        zip.write(content.getBytes(StandardCharsets.UTF_8));
        zip.closeEntry();
    }

    private void writeZipFile(ZipOutputStream zip, String name, File file) throws Exception {
        zip.putNextEntry(new ZipEntry(name));
        if (file.isFile()) try (InputStream input = new FileInputStream(file)) { copyStream(input, zip); }
        zip.closeEntry();
    }

    private static class ExtractionBudget {
        long bytes = 0;
        int entries = 0;
    }

    private void writeStreamToFile(
        InputStream input,
        File target,
        byte[] buffer,
        ExtractionBudget budget,
        long maxEntryBytes
    ) throws Exception {
        long entryBytes = 0;
        try (FileOutputStream output = new FileOutputStream(target)) {
            int read;
            while ((read = input.read(buffer)) != -1) {
                entryBytes += read;
                budget.bytes += read;
                if (entryBytes > maxEntryBytes || budget.bytes > MAX_BACKUP_EXTRACTED_BYTES) {
                    throw new IllegalStateException("备份解压大小超过安全限制");
                }
                output.write(buffer, 0, read);
            }
        }
    }

    private String readZipText(InputStream input, ExtractionBudget budget, long maxBytes) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[64 * 1024];
        int read;
        while ((read = input.read(buffer)) != -1) {
            budget.bytes += read;
            if (output.size() + read > maxBytes || budget.bytes > MAX_BACKUP_EXTRACTED_BYTES) {
                throw new IllegalStateException("备份文本条目超过安全限制");
            }
            output.write(buffer, 0, read);
        }
        return output.toString(StandardCharsets.UTF_8.name());
    }

    private void readEmojiIndex(InputStream input, Map<String, JSONObject> meta, ExtractionBudget budget) throws Exception {
        String[] lines = readZipText(input, budget, 32L * 1024 * 1024).split("\\r?\\n");
        for (String line : lines) {
            String trimmed = line.trim();
            if (trimmed.isEmpty()) continue;
            try {
                JSONObject item = new JSONObject(trimmed);
                String key = item.optLong("roleId") + "/" + item.optString("file");
                meta.put(key, item);
            } catch (Exception ignored) {}
        }
    }

    private boolean safeArchiveFileName(String name) {
        return name != null
            && !name.equals(".")
            && !name.equals("..")
            && name.matches("[\\p{L}\\p{N}._-]{1,220}");
    }

    private File safeArchiveTarget(File directory, String name) throws Exception {
        File root = directory.getCanonicalFile();
        File target = new File(root, name).getCanonicalFile();
        if (!target.getPath().startsWith(root.getPath() + File.separator)) {
            throw new SecurityException("备份包含越界文件路径");
        }
        return target;
    }

    private void commitStagedFiles(List<String[]> staged, File finalRoot) throws Exception {
        for (String[] entry : staged) {
            File directory = new File(finalRoot, entry[0]);
            if (!directory.exists() && !directory.mkdirs()) throw new IllegalStateException("无法创建恢复目标目录");
            File target = safeArchiveTarget(directory, entry[1]);
            File source = new File(entry[2]);
            try (InputStream input = new FileInputStream(source); FileOutputStream output = new FileOutputStream(target)) {
                copyStream(input, output);
            }
            entry[2] = target.getAbsolutePath();
        }
    }

    private int exportChatAttachments(ZipOutputStream zip, Set<Long> roleFilter) throws Exception {
        File root = new File(getContext().getFilesDir(), "chat-attachments");
        File[] roleDirectories = root.listFiles();
        if (roleDirectories == null) return 0;
        int exported = 0;
        for (File roleDirectory : roleDirectories) {
            long roleId;
            try { roleId = Long.parseLong(roleDirectory.getName()); } catch (NumberFormatException ignored) { continue; }
            if (!roleDirectory.isDirectory() || (roleFilter != null && !roleFilter.contains(roleId))) continue;
            File[] files = roleDirectory.listFiles();
            if (files == null) continue;
            for (File file : files) {
                if (!file.isFile() || !safeArchiveFileName(file.getName())) continue;
                zip.putNextEntry(new ZipEntry("attachments/" + roleId + "/" + file.getName()));
                try (InputStream input = new FileInputStream(file)) { copyStream(input, zip); }
                zip.closeEntry();
                exported += 1;
            }
        }
        return exported;
    }

    private File mediaRoot() {
        return new File(getContext().getFilesDir(), "emoji-library");
    }

    private File roleDirectory(long roleId) {
        return new File(mediaRoot(), String.valueOf(roleId));
    }

    private File copyIntoLibrary(Uri source, File directory, String displayName) throws Exception {
        ContentResolver resolver = getContext().getContentResolver();
        String safeName = displayName.replaceAll("[^\\p{L}\\p{N}._-]", "_");
        if (safeName.length() > 80) safeName = safeName.substring(safeName.length() - 80);
        File destination = new File(directory, UUID.randomUUID() + "--" + safeName);
        try (InputStream input = resolver.openInputStream(source); FileOutputStream output = new FileOutputStream(destination)) {
            if (input == null) throw new IllegalStateException("无法读取文件");
            byte[] buffer = new byte[1024 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
        }
        return destination;
    }

    private int importZipIntoLibrary(Uri source, File directory, long roleId) throws Exception {
        int imported = 0;
        int entries = 0;
        long totalBytes = 0;
        ContentResolver resolver = getContext().getContentResolver();
        InputStream rawInput = resolver.openInputStream(source);
        if (rawInput == null) throw new IllegalStateException("无法读取压缩包");
        try (ZipInputStream zip = new ZipInputStream(rawInput)) {
            ZipEntry entry;
            byte[] buffer = new byte[1024 * 1024];
            while ((entry = zip.getNextEntry()) != null) {
                entries += 1;
                if (entries > 10_000) throw new IllegalStateException("表情压缩包文件数超过安全限制");
                if (entry.isDirectory()) { zip.closeEntry(); continue; }
                String entryName = new File(entry.getName()).getName();
                if (entryName.isEmpty() || !isSupportedImage(entryName, null)) { zip.closeEntry(); continue; }
                String safeName = entryName.replaceAll("[^\\p{L}\\p{N}._-]", "_");
                if (safeName.length() > 80) safeName = safeName.substring(safeName.length() - 80);
                File destination = new File(directory, UUID.randomUUID() + "--" + safeName);
                try (FileOutputStream output = new FileOutputStream(destination)) {
                    int read;
                    long entryBytes = 0;
                    while ((read = zip.read(buffer)) != -1) {
                        entryBytes += read;
                        totalBytes += read;
                        if (entryBytes > MAX_MEDIA_ENTRY_BYTES || totalBytes > 1024L * 1024 * 1024) {
                            throw new IllegalStateException("表情压缩包解压大小超过安全限制");
                        }
                        output.write(buffer, 0, read);
                    }
                } catch (Exception error) {
                    destination.delete();
                    throw error;
                }
                mediaDatabase.insert(destination, roleId, nameWithoutExtension(entryName), mimeFromName(entryName));
                imported += 1;
                zip.closeEntry();
            }
        }
        return imported;
    }

    private String displayName(ContentResolver resolver, Uri uri) {
        try (Cursor cursor = resolver.query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (index >= 0) return cursor.getString(index);
            }
        }
        String segment = uri.getLastPathSegment();
        return segment == null ? "image" : segment;
    }

    private String mimeFromName(String name) {
        String lower = name.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".gif")) return "image/gif";
        if (lower.endsWith(".webp")) return "image/webp";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        return "application/octet-stream";
    }

    private boolean isZip(String name, String mime) {
        String lower = name.toLowerCase(Locale.ROOT);
        return lower.endsWith(".zip") || "application/zip".equals(mime) || "application/x-zip-compressed".equals(mime);
    }

    private boolean isSupportedImage(String name, String mime) {
        if (mime != null && mime.startsWith("image/")) return true;
        String lower = name.toLowerCase(Locale.ROOT);
        return lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg")
            || lower.endsWith(".gif") || lower.endsWith(".webp");
    }

    private String nameWithoutExtension(String name) {
        int extension = name.lastIndexOf('.');
        return extension > 0 ? name.substring(0, extension) : name;
    }

    private String extensionForMime(String mime) {
        if ("image/jpeg".equals(mime)) return ".jpg";
        if ("image/gif".equals(mime)) return ".gif";
        if ("image/webp".equals(mime)) return ".webp";
        return ".png";
    }

    private void copyStream(InputStream input, OutputStream output) throws Exception {
        byte[] buffer = new byte[1024 * 1024];
        int read;
        while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
    }

    private void deleteRecursively(File target) {
        if (!target.exists()) return;
        if (target.isDirectory()) {
            File[] children = target.listFiles();
            if (children != null) for (File child : children) deleteRecursively(child);
        }
        target.delete();
    }

    @Override
    protected void handleOnDestroy() {
        ioExecutor.shutdownNow();
        if (mediaDatabase != null) mediaDatabase.close();
    }

    private class MediaDatabase extends SQLiteOpenHelper {
        MediaDatabase() {
            super(getContext(), "mchat2-media.db", null, 1);
        }

        @Override
        public void onCreate(SQLiteDatabase db) {
            db.execSQL("CREATE TABLE media (id TEXT PRIMARY KEY, role_id INTEGER NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL, path TEXT NOT NULL UNIQUE)");
            db.execSQL("CREATE INDEX media_role_time ON media(role_id, created_at DESC)");
        }

        @Override
        public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {}

        void insert(File file, long roleId, String displayName, String mime) {
            ContentValues values = new ContentValues();
            values.put("id", file.getName());
            values.put("role_id", roleId);
            values.put("name", displayName);
            values.put("mime", mime);
            values.put("size", file.length());
            values.put("created_at", file.lastModified());
            values.put("path", file.getAbsolutePath());
            getWritableDatabase().insertOrThrow("media", null, values);
        }

        JSObject list(long roleId, int offset, int limit) {
            SQLiteDatabase db = getReadableDatabase();
            JSArray items = new JSArray();
            try (Cursor cursor = db.query("media", null, "role_id = ?", new String[]{String.valueOf(roleId)}, null, null, "created_at DESC", offset + "," + limit)) {
                while (cursor.moveToNext()) {
                    File file = new File(cursor.getString(cursor.getColumnIndexOrThrow("path")));
                    if (!file.isFile()) continue;
                    JSObject item = new JSObject();
                    item.put("id", cursor.getString(cursor.getColumnIndexOrThrow("id")));
                    item.put("roleId", roleId);
                    item.put("name", cursor.getString(cursor.getColumnIndexOrThrow("name")));
                    item.put("mime", cursor.getString(cursor.getColumnIndexOrThrow("mime")));
                    item.put("size", cursor.getLong(cursor.getColumnIndexOrThrow("size")));
                    item.put("createdAt", cursor.getLong(cursor.getColumnIndexOrThrow("created_at")));
                    item.put("source", "native");
                    item.put("uri", Uri.fromFile(file).toString());
                    items.put(item);
                }
            }
            JSObject summary = roleStats(db, roleId);
            summary.put("items", items);
            return summary;
        }

        JSObject stats() {
            return roleStats(getReadableDatabase(), null);
        }

        private JSObject roleStats(SQLiteDatabase db, Long roleId) {
            String selection = roleId == null ? null : "role_id = ?";
            String[] args = roleId == null ? null : new String[]{String.valueOf(roleId)};
            long total = 0;
            long totalBytes = 0;
            try (Cursor cursor = db.query("media", new String[]{"COUNT(*)", "COALESCE(SUM(size), 0)"}, selection, args, null, null, null)) {
                if (cursor.moveToFirst()) {
                    total = cursor.getLong(0);
                    totalBytes = cursor.getLong(1);
                }
            }
            JSObject response = new JSObject();
            response.put("total", total);
            response.put("totalBytes", totalBytes);
            return response;
        }

        void remove(String path) {
            getWritableDatabase().delete("media", "path = ?", new String[]{path});
        }

        void rename(String path, String name) {
            ContentValues values = new ContentValues();
            values.put("name", name);
            getWritableDatabase().update("media", values, "path = ?", new String[]{path});
        }

        void removeRole(long roleId) {
            getWritableDatabase().delete("media", "role_id = ?", new String[]{String.valueOf(roleId)});
        }

        int exportZip(long roleId, Uri destination) throws Exception {
            int exported = 0;
            Set<String> usedNames = new HashSet<>();
            OutputStream rawOutput = getContext().getContentResolver().openOutputStream(destination);
            if (rawOutput == null) throw new IllegalStateException("无法打开保存位置");
            try (ZipOutputStream zip = new ZipOutputStream(rawOutput)) {
                try (Cursor cursor = getReadableDatabase().query("media", null, "role_id = ?", new String[]{String.valueOf(roleId)}, null, null, "created_at ASC")) {
                    while (cursor.moveToNext()) {
                        File file = new File(cursor.getString(cursor.getColumnIndexOrThrow("path")));
                        if (!file.isFile()) continue;
                        String name = cursor.getString(cursor.getColumnIndexOrThrow("name"));
                        String mime = cursor.getString(cursor.getColumnIndexOrThrow("mime"));
                        if (!name.matches(".*\\.[A-Za-z0-9]{2,5}$")) name += extensionForMime(mime);
                        if (!usedNames.add(name)) name = cursor.getString(cursor.getColumnIndexOrThrow("id")).substring(0, 8) + "-" + name;
                        zip.putNextEntry(new ZipEntry(name));
                        try (InputStream input = new FileInputStream(file)) { copyStream(input, zip); }
                        zip.closeEntry();
                        exported += 1;
                    }
                }
            }
            return exported;
        }

        // 完整备份：先写 emoji-index.ndjson（保留原始名称/mime/时间），再把表情原文件写进 emoji/<roleId>/<fileId>。
        int exportBackup(ZipOutputStream zip, Set<Long> roleFilter) throws Exception {
            String selection = null;
            String[] args = null;
            if (roleFilter != null && !roleFilter.isEmpty()) {
                StringBuilder placeholders = new StringBuilder();
                args = new String[roleFilter.size()];
                int index = 0;
                for (Long id : roleFilter) {
                    placeholders.append(index == 0 ? "?" : ",?");
                    args[index++] = String.valueOf(id);
                }
                selection = "role_id IN (" + placeholders + ")";
            }
            List<String[]> files = new ArrayList<>(); // {roleId, fileId, path}
            zip.putNextEntry(new ZipEntry("emoji-index.ndjson"));
            try (Cursor cursor = getReadableDatabase().query("media", null, selection, args, null, null, "created_at ASC")) {
                while (cursor.moveToNext()) {
                    String id = cursor.getString(cursor.getColumnIndexOrThrow("id"));
                    long roleId = cursor.getLong(cursor.getColumnIndexOrThrow("role_id"));
                    File file = new File(cursor.getString(cursor.getColumnIndexOrThrow("path")));
                    if (!file.isFile()) continue;
                    JSONObject item = new JSONObject();
                    item.put("roleId", roleId);
                    item.put("file", id);
                    item.put("name", cursor.getString(cursor.getColumnIndexOrThrow("name")));
                    item.put("mime", cursor.getString(cursor.getColumnIndexOrThrow("mime")));
                    item.put("size", cursor.getLong(cursor.getColumnIndexOrThrow("size")));
                    item.put("createdAt", cursor.getLong(cursor.getColumnIndexOrThrow("created_at")));
                    zip.write((item + "\n").getBytes(StandardCharsets.UTF_8));
                    files.add(new String[]{String.valueOf(roleId), id, file.getAbsolutePath()});
                }
            }
            zip.closeEntry();
            int exported = 0;
            for (String[] entry : files) {
                File file = new File(entry[2]);
                if (!file.isFile()) continue;
                zip.putNextEntry(new ZipEntry("emoji/" + entry[0] + "/" + entry[1]));
                try (InputStream input = new FileInputStream(file)) { copyStream(input, zip); }
                zip.closeEntry();
                exported += 1;
            }
            return exported;
        }

        // 恢复表情：文件已解压到最终目录，这里按 emoji-index 元数据回填 SQLite（缺失则用文件名兜底），冲突则覆盖。
        int restoreEmojis(List<String[]> staged, Map<String, JSONObject> meta) {
            if (staged.isEmpty()) return 0;
            SQLiteDatabase db = getWritableDatabase();
            int restored = 0;
            db.beginTransaction();
            try {
                for (String[] entry : staged) {
                    String roleId = entry[0];
                    String fileId = entry[1];
                    File file = new File(entry[2]);
                    if (!file.isFile()) continue;
                    JSONObject info = meta.get(roleId + "/" + fileId);
                    String name = info != null ? info.optString("name", nameWithoutExtension(fileId)) : nameWithoutExtension(fileId);
                    String mime = info != null && !info.optString("mime", "").isEmpty() ? info.optString("mime") : mimeFromName(fileId);
                    long createdAt = info != null ? info.optLong("createdAt", file.lastModified()) : file.lastModified();
                    ContentValues values = new ContentValues();
                    values.put("id", fileId);
                    values.put("role_id", Long.parseLong(roleId));
                    values.put("name", name);
                    values.put("mime", mime);
                    values.put("size", file.length());
                    values.put("created_at", createdAt);
                    values.put("path", file.getAbsolutePath());
                    db.insertWithOnConflict("media", null, values, SQLiteDatabase.CONFLICT_REPLACE);
                    restored += 1;
                }
                db.setTransactionSuccessful();
            } finally {
                db.endTransaction();
            }
            return restored;
        }
    }
}
