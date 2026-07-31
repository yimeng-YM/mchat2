package com.mchat2

import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.util.UUID
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream

internal data class MediaImportSummary(val imported: Int, val failed: Int, val firstError: String?)

internal class MediaLibraryService(
    private val context: Context,
    private val database: MediaDatabase,
) {
    fun importAll(uris: List<Uri>, roleId: Long, onProgress: (processed: Int, total: Int) -> Unit): MediaImportSummary {
        require(roleId > 0) { "无效的角色 ID" }
        val directory = roleDirectory(roleId)
        check(directory.exists() || directory.mkdirs()) { "无法创建角色表情包目录" }

        var imported = 0
        var failed = 0
        var firstError: String? = null
        val importDatabase = database.writableDatabase
        importDatabase.beginTransaction()
        try {
            uris.forEach { uri ->
                try {
                    val displayName = displayName(context.contentResolver, uri)
                    val mime = context.contentResolver.getType(uri)
                    when {
                        NativeFileRules.isZip(displayName, mime) -> {
                            val zipImported = importZipIntoLibrary(uri, directory, roleId)
                            imported += zipImported
                            if (zipImported == 0) failed += 1
                        }

                        NativeFileRules.isSupportedImage(displayName, mime) -> {
                            val storedFile = copyIntoLibrary(uri, directory, displayName)
                            database.insert(
                                storedFile,
                                roleId,
                                NativeFileRules.nameWithoutExtension(displayName),
                                NativeFileRules.mimeFromName(displayName),
                            )
                            imported += 1
                        }

                        else -> failed += 1
                    }
                } catch (error: Exception) {
                    failed += 1
                    if (firstError == null) firstError = error.message
                }
                onProgress(imported + failed, uris.size)
            }
            importDatabase.setTransactionSuccessful()
        } finally {
            importDatabase.endTransaction()
        }
        return MediaImportSummary(imported, failed, firstError)
    }

    fun remove(rawUri: String): Boolean {
        val root = mediaRoot().canonicalFile
        val path = requireNotNull(Uri.parse(rawUri).path) { "文件路径无效" }
        val target = File(path).canonicalFile
        val insideLibrary = target.path.startsWith(root.path + File.separator)
        val removed = insideLibrary && target.isFile && target.delete()
        if (removed) database.remove(target.path)
        return removed
    }

    fun rename(rawUri: String, name: String) {
        val root = mediaRoot().canonicalFile
        val path = requireNotNull(Uri.parse(rawUri).path) { "文件路径无效" }
        val target = File(path).canonicalFile
        val insideLibrary = target.path.startsWith(root.path + File.separator)
        require(insideLibrary && target.isFile) { "无效的表情文件" }
        database.rename(target.path, name)
    }

    fun removeRole(roleId: Long) {
        NativeFiles.deleteRecursively(roleDirectory(roleId))
        database.removeRole(roleId)
    }

    fun exportChatAttachments(zip: ZipOutputStream, roleFilter: Set<Long>?): Int {
        val root = File(context.filesDir, "chat-attachments")
        val roleDirectories = root.listFiles() ?: return 0
        var exported = 0
        roleDirectories.forEach { roleDirectory ->
            val roleId = roleDirectory.name.toLongOrNull() ?: return@forEach
            if (!roleDirectory.isDirectory || roleFilter?.contains(roleId) == false) return@forEach
            roleDirectory.listFiles()?.forEach { file ->
                if (!file.isFile || !NativeFileRules.safeArchiveFileName(file.name)) return@forEach
                zip.putNextEntry(ZipEntry("attachments/$roleId/${file.name}"))
                FileInputStream(file).use { NativeFiles.copy(it, zip) }
                zip.closeEntry()
                exported += 1
            }
        }
        return exported
    }

    fun commitStagedFiles(staged: List<Array<String>>, finalRoot: File) {
        staged.forEach { entry ->
            val directory = File(finalRoot, entry[0])
            check(directory.exists() || directory.mkdirs()) { "无法创建恢复目标目录" }
            val target = NativeFileRules.safeArchiveTarget(directory, entry[1])
            FileInputStream(File(entry[2])).use { input ->
                FileOutputStream(target).use { output -> NativeFiles.copy(input, output) }
            }
            entry[2] = target.absolutePath
        }
    }

    fun mediaRoot(): File = File(context.filesDir, "emoji-library")

    fun roleDirectory(roleId: Long): File = File(mediaRoot(), roleId.toString())

    private fun copyIntoLibrary(source: Uri, directory: File, displayName: String): File {
        val safeName = NativeFileRules.sanitizeFileName(displayName, 80)
        val destination = File(directory, "${UUID.randomUUID()}--$safeName")
        context.contentResolver.openInputStream(source).use { input ->
            checkNotNull(input) { "无法读取文件" }
            FileOutputStream(destination).use { output -> NativeFiles.copy(input, output) }
        }
        return destination
    }

    private fun importZipIntoLibrary(source: Uri, directory: File, roleId: Long): Int {
        var imported = 0
        var entries = 0
        var totalBytes = 0L
        val rawInput = context.contentResolver.openInputStream(source) ?: error("无法读取压缩包")
        ZipInputStream(rawInput).use { zip ->
            val buffer = ByteArray(1024 * 1024)
            while (true) {
                val entry = zip.nextEntry ?: break
                entries += 1
                check(entries <= 10_000) { "表情压缩包文件数超过安全限制" }
                if (entry.isDirectory) {
                    zip.closeEntry()
                    continue
                }
                val entryName = File(entry.name).name
                if (entryName.isEmpty() || !NativeFileRules.isSupportedImage(entryName, null)) {
                    zip.closeEntry()
                    continue
                }
                val safeName = NativeFileRules.sanitizeFileName(entryName, 80)
                val destination = File(directory, "${UUID.randomUUID()}--$safeName")
                try {
                    FileOutputStream(destination).use { output ->
                        var entryBytes = 0L
                        while (true) {
                            val read = zip.read(buffer)
                            if (read == -1) break
                            entryBytes += read
                            totalBytes += read
                            check(entryBytes <= MAX_MEDIA_ENTRY_BYTES && totalBytes <= MAX_EMOJI_ARCHIVE_BYTES) {
                                "表情压缩包解压大小超过安全限制"
                            }
                            output.write(buffer, 0, read)
                        }
                    }
                } catch (error: Exception) {
                    destination.delete()
                    throw error
                }
                database.insert(
                    destination,
                    roleId,
                    NativeFileRules.nameWithoutExtension(entryName),
                    NativeFileRules.mimeFromName(entryName),
                )
                imported += 1
                zip.closeEntry()
            }
        }
        return imported
    }

    private fun displayName(resolver: ContentResolver, uri: Uri): String {
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (index >= 0) return cursor.getString(index)
            }
        }
        return uri.lastPathSegment ?: "image"
    }

    companion object {
        private const val MAX_MEDIA_ENTRY_BYTES = 128L * 1024 * 1024
        private const val MAX_EMOJI_ARCHIVE_BYTES = 1024L * 1024 * 1024
    }
}
