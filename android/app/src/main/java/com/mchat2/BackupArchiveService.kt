package com.mchat2

import android.content.Context
import android.net.Uri
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.nio.charset.StandardCharsets
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream
import org.json.JSONObject

internal data class BackupCounts(val emojis: Int, val attachments: Int)

internal data class RestoreResult(
    val conversations: File,
    val memories: File,
    val assets: File,
    val attachmentRoot: File,
    val manifest: String,
    val emojis: Int,
    val attachments: Int,
)

internal class BackupArchiveService(
    private val context: Context,
    private val database: MediaDatabase,
    private val mediaLibrary: MediaLibraryService,
) {
    fun assemble(
        destination: Uri,
        manifest: String,
        conversations: File,
        memories: File,
        assets: File,
        roleFilter: Set<Long>?,
    ): BackupCounts {
        val rawOutput = context.contentResolver.openOutputStream(destination) ?: error("无法打开保存位置")
        var emojis: Int
        var attachments: Int
        ZipOutputStream(rawOutput).use { zip ->
            writeZipText(zip, "manifest.json", manifest)
            writeZipFile(zip, "conversations.ndjson", conversations)
            writeZipFile(zip, "memories.ndjson", memories)
            writeZipFile(zip, "assets.ndjson", assets)
            emojis = database.exportBackup(zip, roleFilter)
            attachments = mediaLibrary.exportChatAttachments(zip, roleFilter)
        }
        return BackupCounts(emojis, attachments)
    }

    fun restore(source: Uri): RestoreResult {
        val workDirectory = File(context.cacheDir, "restore")
        NativeFiles.deleteRecursively(workDirectory)
        check(workDirectory.mkdirs()) { "无法创建恢复目录" }
        val conversations = File(workDirectory, "conversations.ndjson")
        val memories = File(workDirectory, "memories.ndjson")
        val assets = File(workDirectory, "assets.ndjson")
        val emojiMetadata = mutableMapOf<String, JSONObject>()
        val stagedEmojis = mutableListOf<Array<String>>()
        val stagedAttachments = mutableListOf<Array<String>>()
        val budget = ExtractionBudget()
        var manifest: String? = null

        val rawInput = context.contentResolver.openInputStream(source) ?: error("无法读取备份文件")
        ZipInputStream(rawInput).use { zip ->
            val buffer = ByteArray(1024 * 1024)
            while (true) {
                val entry = zip.nextEntry ?: break
                budget.entries += 1
                check(budget.entries <= MAX_ZIP_ENTRIES) { "备份文件条目数超过安全限制" }
                val entryName = entry.name
                if (entry.isDirectory) {
                    zip.closeEntry()
                    continue
                }
                when {
                    entryName == "manifest.json" -> manifest = readZipText(zip, budget, MAX_MANIFEST_BYTES)
                    entryName == "conversations.ndjson" ->
                        writeStreamToFile(zip, conversations, buffer, budget, MAX_ARCHIVE_ENTRY_BYTES)
                    entryName == "memories.ndjson" ->
                        writeStreamToFile(zip, memories, buffer, budget, MAX_ARCHIVE_ENTRY_BYTES)
                    entryName == "assets.ndjson" ->
                        writeStreamToFile(zip, assets, buffer, budget, MAX_ARCHIVE_ENTRY_BYTES)
                    entryName == "emoji-index.ndjson" -> readEmojiIndex(zip, emojiMetadata, budget)
                    entryName.startsWith("emoji/") -> stageMediaEntry(
                        zip,
                        entryName,
                        File(workDirectory, "emoji-stage"),
                        buffer,
                        budget,
                        stagedEmojis,
                        false,
                    )
                    entryName.startsWith("attachments/") -> stageMediaEntry(
                        zip,
                        entryName,
                        File(workDirectory, "attachment-stage"),
                        buffer,
                        budget,
                        stagedAttachments,
                        true,
                    )
                }
                zip.closeEntry()
            }
        }

        val manifestText = manifest ?: error("备份缺少 manifest.json")
        val manifestObject = JSONObject(manifestText)
        val version = manifestObject.optInt("version", 0)
        check(manifestObject.optString("type") == "mchat2-full-backup" && (version == 1 || version == 2)) {
            "备份清单格式或版本不受支持"
        }
        mediaLibrary.commitStagedFiles(stagedEmojis, mediaLibrary.mediaRoot())
        val attachmentRoot = File(context.filesDir, "chat-attachments")
        mediaLibrary.commitStagedFiles(stagedAttachments, attachmentRoot)
        val restoredEmojis = database.restoreEmojis(stagedEmojis, emojiMetadata)
        return RestoreResult(
            conversations = conversations,
            memories = memories,
            assets = assets,
            attachmentRoot = attachmentRoot,
            manifest = manifestText,
            emojis = restoredEmojis,
            attachments = stagedAttachments.size,
        )
    }

    private fun stageMediaEntry(
        zip: ZipInputStream,
        entryName: String,
        stagingRoot: File,
        buffer: ByteArray,
        budget: ExtractionBudget,
        staged: MutableList<Array<String>>,
        strictDirectoryCreation: Boolean,
    ) {
        val parts = entryName.split('/')
        if (parts.size != 3 || parts[1].isEmpty() || parts[2].isEmpty()) return
        val roleId = parts[1].toLongOrNull() ?: return
        if (roleId <= 0 || !NativeFileRules.safeArchiveFileName(parts[2])) return
        val directory = File(stagingRoot, roleId.toString())
        if (!directory.exists() && !directory.mkdirs()) {
            if (strictDirectoryCreation) error("无法创建附件恢复目录") else return
        }
        val target = NativeFileRules.safeArchiveTarget(directory, parts[2])
        writeStreamToFile(zip, target, buffer, budget, MAX_MEDIA_ENTRY_BYTES)
        staged += arrayOf(roleId.toString(), parts[2], target.absolutePath)
    }

    private fun writeZipText(zip: ZipOutputStream, name: String, content: String) {
        zip.putNextEntry(ZipEntry(name))
        zip.write(content.toByteArray(StandardCharsets.UTF_8))
        zip.closeEntry()
    }

    private fun writeZipFile(zip: ZipOutputStream, name: String, file: File) {
        zip.putNextEntry(ZipEntry(name))
        if (file.isFile) FileInputStream(file).use { NativeFiles.copy(it, zip) }
        zip.closeEntry()
    }

    private fun writeStreamToFile(
        input: InputStream,
        target: File,
        buffer: ByteArray,
        budget: ExtractionBudget,
        maxEntryBytes: Long,
    ) {
        var entryBytes = 0L
        FileOutputStream(target).use { output ->
            while (true) {
                val read = input.read(buffer)
                if (read == -1) break
                entryBytes += read
                budget.bytes += read
                check(entryBytes <= maxEntryBytes && budget.bytes <= MAX_BACKUP_EXTRACTED_BYTES) {
                    "备份解压大小超过安全限制"
                }
                output.write(buffer, 0, read)
            }
        }
    }

    private fun readZipText(input: InputStream, budget: ExtractionBudget, maxBytes: Long): String {
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(64 * 1024)
        while (true) {
            val read = input.read(buffer)
            if (read == -1) break
            budget.bytes += read
            check(output.size().toLong() + read <= maxBytes && budget.bytes <= MAX_BACKUP_EXTRACTED_BYTES) {
                "备份文本条目超过安全限制"
            }
            output.write(buffer, 0, read)
        }
        return output.toString(StandardCharsets.UTF_8.name())
    }

    private fun readEmojiIndex(
        input: InputStream,
        metadata: MutableMap<String, JSONObject>,
        budget: ExtractionBudget,
    ) {
        readZipText(input, budget, 32L * 1024 * 1024).lineSequence().forEach { line ->
            val trimmed = line.trim()
            if (trimmed.isEmpty()) return@forEach
            try {
                val item = JSONObject(trimmed)
                metadata["${item.optLong("roleId")}/${item.optString("file")}"] = item
            } catch (_: Exception) {
                // 与旧实现一致：单条损坏的可选元数据不会阻止整个备份恢复。
            }
        }
    }

    private data class ExtractionBudget(var bytes: Long = 0, var entries: Int = 0)

    companion object {
        private const val MAX_ZIP_ENTRIES = 50_000
        private const val MAX_BACKUP_EXTRACTED_BYTES = 2L * 1024 * 1024 * 1024
        private const val MAX_ARCHIVE_ENTRY_BYTES = 512L * 1024 * 1024
        private const val MAX_MEDIA_ENTRY_BYTES = 128L * 1024 * 1024
        private const val MAX_MANIFEST_BYTES = 256L * 1024
    }
}
