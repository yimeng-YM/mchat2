package com.mchat2

import android.content.ContentResolver
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import kotlin.math.max
import kotlin.math.roundToInt

internal data class NativeAttachment(
    val id: String,
    val name: String,
    val mime: String,
    val size: Long,
    val uri: String,
)

internal class AttachmentService(private val context: Context) {
    fun importImage(source: Uri, roleId: Long): NativeAttachment {
        val resolver = context.contentResolver
        val name = displayName(resolver, source)
        val mime = resolver.getType(source) ?: "image/jpeg"
        val directory = File(context.filesDir, "chat-attachments/$roleId")
        check(directory.exists() || directory.mkdirs()) { "无法创建附件目录" }

        var safeName = name.replace(Regex("[^\\p{L}\\p{N}._-]"), "_")
        if (safeName.length > 100) safeName = safeName.takeLast(100)
        val destination = File(directory, "${UUID.randomUUID()}--$safeName")
        resolver.openInputStream(source).use { input ->
            checkNotNull(input) { "无法读取图片" }
            FileOutputStream(destination).use { output -> input.copyTo(output, DEFAULT_BUFFER_SIZE) }
        }
        return NativeAttachment(
            id = destination.name,
            name = name,
            mime = mime,
            size = destination.length(),
            uri = Uri.fromFile(destination).toString(),
        )
    }

    fun readImageDataUrl(rawUri: String, maxDimension: Int, quality: Int): String {
        val path = requireNotNull(Uri.parse(rawUri).path) { "图片路径无效" }
        val attachmentRoot = File(context.filesDir, "chat-attachments").canonicalFile
        val resolved = File(path).canonicalFile
        if (!resolved.path.startsWith(attachmentRoot.path + File.separator)) {
            throw SecurityException("图片不在附件目录中")
        }

        val bitmap = checkNotNull(decodeScaledBitmap(resolved, max(320, maxDimension))) { "无法解析图片" }
        return ByteArrayOutputStream().use { output ->
            bitmap.compress(Bitmap.CompressFormat.JPEG, quality.coerceIn(40, 95), output)
            bitmap.recycle()
            "data:image/jpeg;base64," + Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP)
        }
    }

    fun removeRoleFiles(roleId: Long) {
        deleteRecursively(File(context.filesDir, "chat-attachments/$roleId"))
    }

    private fun displayName(resolver: ContentResolver, uri: Uri): String {
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (index >= 0) return cursor.getString(index)
            }
        }
        return uri.lastPathSegment ?: "attachment"
    }

    private fun decodeScaledBitmap(file: File, maxDimension: Int): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.absolutePath, bounds)
        var sample = 1
        while (max(bounds.outWidth / sample, bounds.outHeight / sample) > maxDimension * 2) sample *= 2
        val decoded = BitmapFactory.decodeFile(
            file.absolutePath,
            BitmapFactory.Options().apply { inSampleSize = sample },
        ) ?: return null
        val largest = max(decoded.width, decoded.height)
        if (largest <= maxDimension) return decoded
        val scale = maxDimension.toFloat() / largest
        val scaled = Bitmap.createScaledBitmap(
            decoded,
            max(1, (decoded.width * scale).roundToInt()),
            max(1, (decoded.height * scale).roundToInt()),
            true,
        )
        if (scaled !== decoded) decoded.recycle()
        return scaled
    }

    private fun deleteRecursively(target: File) {
        if (!target.exists()) return
        if (target.isDirectory) target.listFiles()?.forEach(::deleteRecursively)
        target.delete()
    }
}
