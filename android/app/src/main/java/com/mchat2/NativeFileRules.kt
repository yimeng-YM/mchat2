package com.mchat2

import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.util.Locale

internal object NativeFileRules {
    fun sanitizeFileName(name: String, maxLength: Int): String {
        val sanitized = name.replace(Regex("[^\\p{L}\\p{N}._-]"), "_")
        return if (sanitized.length > maxLength) sanitized.takeLast(maxLength) else sanitized
    }

    fun safeArchiveFileName(name: String?): Boolean =
        name != null && name != "." && name != ".." && Regex("[\\p{L}\\p{N}._-]{1,220}").matches(name)

    fun safeArchiveTarget(directory: File, name: String): File {
        val root = directory.canonicalFile
        val target = File(root, name).canonicalFile
        if (!target.path.startsWith(root.path + File.separator)) {
            throw SecurityException("备份包含越界文件路径")
        }
        return target
    }

    fun mimeFromName(name: String): String = when {
        name.lowercase(Locale.ROOT).endsWith(".png") -> "image/png"
        name.lowercase(Locale.ROOT).endsWith(".gif") -> "image/gif"
        name.lowercase(Locale.ROOT).endsWith(".webp") -> "image/webp"
        name.lowercase(Locale.ROOT).endsWith(".jpg") || name.lowercase(Locale.ROOT).endsWith(".jpeg") -> "image/jpeg"
        else -> "application/octet-stream"
    }

    fun isZip(name: String, mime: String?): Boolean {
        val lower = name.lowercase(Locale.ROOT)
        return lower.endsWith(".zip") || mime == "application/zip" || mime == "application/x-zip-compressed"
    }

    fun isSupportedImage(name: String, mime: String?): Boolean {
        if (mime?.startsWith("image/") == true) return true
        val lower = name.lowercase(Locale.ROOT)
        return lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg") ||
            lower.endsWith(".gif") || lower.endsWith(".webp")
    }

    fun nameWithoutExtension(name: String): String {
        val extension = name.lastIndexOf('.')
        return if (extension > 0) name.substring(0, extension) else name
    }

    fun extensionForMime(mime: String): String = when (mime) {
        "image/jpeg" -> ".jpg"
        "image/gif" -> ".gif"
        "image/webp" -> ".webp"
        else -> ".png"
    }
}

internal object NativeFiles {
    fun copy(input: InputStream, output: OutputStream) {
        input.copyTo(output, 1024 * 1024)
    }

    fun deleteRecursively(target: File) {
        if (!target.exists()) return
        if (target.isDirectory) target.listFiles()?.forEach(::deleteRecursively)
        target.delete()
    }
}
