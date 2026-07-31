package com.mchat2

import android.content.Context
import java.io.File
import java.io.FileOutputStream
import java.nio.charset.StandardCharsets
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

internal class ExportSessionManager(private val context: Context) {
    private val pending = ConcurrentHashMap<String, File>()

    fun begin(): String {
        val directory = File(context.cacheDir, "exports")
        check(directory.exists() || directory.mkdirs()) { "无法创建导出目录" }
        val token = UUID.randomUUID().toString()
        val file = File(directory, "$token.ndjson")
        check(file.createNewFile()) { "无法创建导出文件" }
        pending[token] = file
        return token
    }

    fun append(token: String, chunk: String) {
        val file = pending[token] ?: error("导出任务已失效")
        FileOutputStream(file, true).use { it.write(chunk.toByteArray(StandardCharsets.UTF_8)) }
    }

    fun contains(token: String): Boolean = pending.containsKey(token)

    fun containsAll(vararg tokens: String): Boolean = tokens.all(pending::containsKey)

    fun take(token: String): File? = pending.remove(token)

    fun close() {
        pending.values.forEach(File::delete)
        pending.clear()
    }
}
