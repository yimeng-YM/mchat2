package com.mchat2

import android.app.Activity
import android.content.Intent
import android.net.Uri
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.FileInputStream
import java.util.concurrent.Executors
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

@CapacitorPlugin(name = "LargeMedia")
class LargeMediaPlugin : Plugin() {
    private val ioDispatcher = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
    private val ioScope = CoroutineScope(SupervisorJob() + ioDispatcher)
    private lateinit var database: MediaDatabase
    private lateinit var mediaLibrary: MediaLibraryService
    private lateinit var backupArchive: BackupArchiveService
    private lateinit var exportSessions: ExportSessionManager

    override fun load() {
        database = MediaDatabase(context)
        mediaLibrary = MediaLibraryService(context, database)
        backupArchive = BackupArchiveService(context, database, mediaLibrary)
        exportSessions = ExportSessionManager(context)
    }

    @PluginMethod
    fun pickAndImport(call: PluginCall) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType("*/*")
            .putExtra(
                Intent.EXTRA_MIME_TYPES,
                arrayOf(
                    "image/png",
                    "image/jpeg",
                    "image/gif",
                    "image/webp",
                    "application/zip",
                    "application/x-zip-compressed",
                ),
            )
            .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        startActivityForResult(call, intent, "pickAndImportResult")
    }

    @ActivityCallback
    private fun pickAndImportResult(call: PluginCall, result: ActivityResult) {
        val data = result.data
        if (result.resultCode != Activity.RESULT_OK || data == null) {
            call.resolve(JSObject().put("imported", 0).put("failed", 0))
            return
        }
        val roleId = call.getLong("roleId", 0L) ?: 0L
        if (roleId <= 0) {
            call.reject("无效的角色 ID")
            return
        }
        val uris = buildList {
            val clipData = data.clipData
            if (clipData != null) {
                for (index in 0 until clipData.itemCount) add(clipData.getItemAt(index).uri)
            } else {
                data.data?.let(::add)
            }
        }
        ioScope.launch {
            try {
                val summary = mediaLibrary.importAll(uris, roleId) { processed, total ->
                    notifyListeners(
                        "importProgress",
                        JSObject().put("processed", processed).put("total", total),
                    )
                }
                call.resolve(
                    JSObject()
                        .put("imported", summary.imported)
                        .put("failed", summary.failed)
                        .apply { summary.firstError?.let { put("message", it) } },
                )
            } catch (error: Exception) {
                call.reject(error.message ?: "导入文件失败", error)
            }
        }
    }

    @PluginMethod
    fun list(call: PluginCall) {
        val roleId = call.getLong("roleId", 0L) ?: 0L
        val offset = (call.getInt("offset", 0) ?: 0).coerceAtLeast(0)
        val limit = (call.getInt("limit", 60) ?: 60).coerceIn(1, 200)
        ioScope.launch { call.resolve(database.list(roleId, offset, limit)) }
    }

    @PluginMethod
    fun remove(call: PluginCall) {
        val rawUri = call.getString("uri", "") ?: ""
        ioScope.launch {
            try {
                call.resolve(JSObject().put("removed", mediaLibrary.remove(rawUri)))
            } catch (error: Exception) {
                call.reject("删除文件失败", error)
            }
        }
    }

    @PluginMethod
    fun rename(call: PluginCall) {
        val rawUri = call.getString("uri", "") ?: ""
        val name = (call.getString("name", "") ?: "").trim()
        if (name.isEmpty()) {
            call.reject("表情名称不能为空")
            return
        }
        ioScope.launch {
            try {
                mediaLibrary.rename(rawUri, name)
                call.resolve(JSObject().put("renamed", true))
            } catch (error: IllegalArgumentException) {
                call.reject(error.message ?: "无效的表情文件")
            } catch (error: Exception) {
                call.reject("重命名表情失败", error)
            }
        }
    }

    @PluginMethod
    fun stats(call: PluginCall) {
        ioScope.launch { call.resolve(database.stats()) }
    }

    @PluginMethod
    fun removeRole(call: PluginCall) {
        val roleId = call.getLong("roleId", 0L) ?: 0L
        ioScope.launch {
            mediaLibrary.removeRole(roleId)
            call.resolve()
        }
    }

    @PluginMethod
    fun beginTextExport(call: PluginCall) {
        ioScope.launch {
            try {
                call.resolve(JSObject().put("token", exportSessions.begin()))
            } catch (error: Exception) {
                call.reject("无法开始导出", error)
            }
        }
    }

    @PluginMethod
    fun appendTextExport(call: PluginCall) {
        val token = call.getString("token", "") ?: ""
        val chunk = call.getString("chunk", "") ?: ""
        ioScope.launch {
            try {
                exportSessions.append(token, chunk)
                call.resolve()
            } catch (error: IllegalStateException) {
                call.reject(error.message ?: "导出任务已失效")
            } catch (error: Exception) {
                call.reject("写入导出文件失败", error)
            }
        }
    }

    @PluginMethod
    fun saveTextExport(call: PluginCall) {
        val token = call.getString("token", "") ?: ""
        if (!exportSessions.contains(token)) {
            call.reject("导出任务已失效")
            return
        }
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType("application/x-ndjson")
            .putExtra(Intent.EXTRA_TITLE, call.getString("name", "mchat2-conversations.ndjson"))
        startActivityForResult(call, intent, "saveTextExportResult")
    }

    @ActivityCallback
    private fun saveTextExportResult(call: PluginCall, result: ActivityResult) {
        val token = call.getString("token", "") ?: ""
        val source = exportSessions.take(token)
        val destination = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || destination == null) {
            source?.delete()
            call.resolve(JSObject().put("saved", false))
            return
        }
        ioScope.launch {
            try {
                checkNotNull(source) { "临时归档不存在" }
                context.contentResolver.openOutputStream(destination).use { output ->
                    checkNotNull(output) { "无法打开保存位置" }
                    FileInputStream(source).use { input -> NativeFiles.copy(input, output) }
                }
                source.delete()
                call.resolve(JSObject().put("saved", true))
            } catch (error: Exception) {
                call.reject("保存归档失败", error)
            }
        }
    }

    @PluginMethod
    fun exportRolePack(call: PluginCall) {
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType("application/zip")
            .putExtra(Intent.EXTRA_TITLE, call.getString("name", "emoji-pack.zip"))
        startActivityForResult(call, intent, "exportRolePackResult")
    }

    @ActivityCallback
    private fun exportRolePackResult(call: PluginCall, result: ActivityResult) {
        val destination = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || destination == null) {
            call.resolve(JSObject().put("saved", false).put("exported", 0))
            return
        }
        val roleId = call.getLong("roleId", 0L) ?: 0L
        ioScope.launch {
            try {
                val exported = database.exportZip(roleId, destination)
                call.resolve(JSObject().put("saved", true).put("exported", exported))
            } catch (error: Exception) {
                call.reject("导出表情包失败", error)
            }
        }
    }

    @PluginMethod
    fun assembleBackup(call: PluginCall) {
        val convToken = call.getString("convToken", "") ?: ""
        val memToken = call.getString("memToken", "") ?: ""
        val assetToken = call.getString("assetToken", "") ?: ""
        if (!exportSessions.containsAll(convToken, memToken, assetToken)) {
            call.reject("备份数据已失效，请重试")
            return
        }
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType("application/zip")
            .putExtra(Intent.EXTRA_TITLE, call.getString("name", "MChat2-backup.zip"))
        startActivityForResult(call, intent, "assembleBackupResult")
    }

    @ActivityCallback
    private fun assembleBackupResult(call: PluginCall, result: ActivityResult) {
        val conversations = exportSessions.take(call.getString("convToken", "") ?: "")
        val memories = exportSessions.take(call.getString("memToken", "") ?: "")
        val assets = exportSessions.take(call.getString("assetToken", "") ?: "")
        val destination = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || destination == null) {
            conversations?.delete()
            memories?.delete()
            assets?.delete()
            call.resolve(JSObject().put("saved", false).put("emojis", 0).put("attachments", 0))
            return
        }
        val manifest = call.getString("manifest", "{}") ?: "{}"
        val roleFilter = parseRoleFilter(call.getArray("roleIds", null))
        ioScope.launch {
            try {
                checkNotNull(conversations) { "备份临时文件缺失" }
                checkNotNull(memories) { "备份临时文件缺失" }
                checkNotNull(assets) { "备份临时文件缺失" }
                val counts = backupArchive.assemble(
                    destination,
                    manifest,
                    conversations,
                    memories,
                    assets,
                    roleFilter,
                )
                call.resolve(
                    JSObject()
                        .put("saved", true)
                        .put("emojis", counts.emojis)
                        .put("attachments", counts.attachments),
                )
            } catch (error: Exception) {
                call.reject("生成备份失败", error)
            } finally {
                conversations?.delete()
                memories?.delete()
                assets?.delete()
            }
        }
    }

    @PluginMethod
    fun pickBackup(call: PluginCall) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType("*/*")
            .putExtra(
                Intent.EXTRA_MIME_TYPES,
                arrayOf("application/zip", "application/x-zip-compressed", "application/octet-stream"),
            )
        startActivityForResult(call, intent, "pickBackupResult")
    }

    @ActivityCallback
    private fun pickBackupResult(call: PluginCall, result: ActivityResult) {
        val source = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || source == null) {
            call.resolve(JSObject().put("restored", false))
            return
        }
        ioScope.launch {
            try {
                val restored = backupArchive.restore(source)
                call.resolve(
                    JSObject()
                        .put("restored", true)
                        .put("conversationsPath", restored.conversations.takeIf { it.isFile }?.let(Uri::fromFile)?.toString().orEmpty())
                        .put("memoriesPath", restored.memories.takeIf { it.isFile }?.let(Uri::fromFile)?.toString().orEmpty())
                        .put("assetsPath", restored.assets.takeIf { it.isFile }?.let(Uri::fromFile)?.toString().orEmpty())
                        .put("attachmentRootUri", Uri.fromFile(restored.attachmentRoot).toString())
                        .put("manifest", restored.manifest)
                        .put("emojis", restored.emojis)
                        .put("attachments", restored.attachments),
                )
            } catch (error: Exception) {
                call.reject("恢复备份失败", error)
            }
        }
    }

    private fun parseRoleFilter(roleIds: JSArray?): Set<Long>? {
        if (roleIds == null) return null
        val filter = buildSet {
            for (index in 0 until roleIds.length()) {
                roleIds.optLong(index, 0L).takeIf { it > 0 }?.let(::add)
            }
        }
        return filter.ifEmpty { null }
    }

    override fun handleOnDestroy() {
        ioScope.cancel()
        exportSessions.close()
        database.close()
        ioDispatcher.close()
        super.handleOnDestroy()
    }
}
