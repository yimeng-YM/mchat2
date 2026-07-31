package com.mchat2

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.net.Uri
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import java.io.File
import java.io.FileInputStream
import java.nio.charset.StandardCharsets
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import org.json.JSONObject

internal class MediaDatabase(private val appContext: Context) :
    SQLiteOpenHelper(appContext, "mchat2-media.db", null, 1) {

    override fun onCreate(database: SQLiteDatabase) {
        database.execSQL(
            "CREATE TABLE media (id TEXT PRIMARY KEY, role_id INTEGER NOT NULL, name TEXT NOT NULL, " +
                "mime TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL, path TEXT NOT NULL UNIQUE)",
        )
        database.execSQL("CREATE INDEX media_role_time ON media(role_id, created_at DESC)")
    }

    override fun onUpgrade(database: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit

    fun insert(file: File, roleId: Long, displayName: String, mime: String) {
        val values = ContentValues().apply {
            put("id", file.name)
            put("role_id", roleId)
            put("name", displayName)
            put("mime", mime)
            put("size", file.length())
            put("created_at", file.lastModified())
            put("path", file.absolutePath)
        }
        writableDatabase.insertOrThrow("media", null, values)
    }

    fun list(roleId: Long, offset: Int, limit: Int): JSObject {
        val database = readableDatabase
        val items = JSArray()
        database.query(
            "media",
            null,
            "role_id = ?",
            arrayOf(roleId.toString()),
            null,
            null,
            "created_at DESC",
            "$offset,$limit",
        ).use { cursor ->
            while (cursor.moveToNext()) {
                val file = File(cursor.getString(cursor.getColumnIndexOrThrow("path")))
                if (!file.isFile) continue
                items.put(
                    JSObject()
                        .put("id", cursor.getString(cursor.getColumnIndexOrThrow("id")))
                        .put("roleId", roleId)
                        .put("name", cursor.getString(cursor.getColumnIndexOrThrow("name")))
                        .put("mime", cursor.getString(cursor.getColumnIndexOrThrow("mime")))
                        .put("size", cursor.getLong(cursor.getColumnIndexOrThrow("size")))
                        .put("createdAt", cursor.getLong(cursor.getColumnIndexOrThrow("created_at")))
                        .put("source", "native")
                        .put("uri", Uri.fromFile(file).toString()),
                )
            }
        }
        return roleStats(database, roleId).put("items", items)
    }

    fun stats(): JSObject = roleStats(readableDatabase, null)

    private fun roleStats(database: SQLiteDatabase, roleId: Long?): JSObject {
        val selection = roleId?.let { "role_id = ?" }
        val args = roleId?.let { arrayOf(it.toString()) }
        var total = 0L
        var totalBytes = 0L
        database.query(
            "media",
            arrayOf("COUNT(*)", "COALESCE(SUM(size), 0)"),
            selection,
            args,
            null,
            null,
            null,
        ).use { cursor ->
            if (cursor.moveToFirst()) {
                total = cursor.getLong(0)
                totalBytes = cursor.getLong(1)
            }
        }
        return JSObject().put("total", total).put("totalBytes", totalBytes)
    }

    fun remove(path: String) {
        writableDatabase.delete("media", "path = ?", arrayOf(path))
    }

    fun rename(path: String, name: String) {
        writableDatabase.update("media", ContentValues().apply { put("name", name) }, "path = ?", arrayOf(path))
    }

    fun removeRole(roleId: Long) {
        writableDatabase.delete("media", "role_id = ?", arrayOf(roleId.toString()))
    }

    fun exportZip(roleId: Long, destination: Uri): Int {
        var exported = 0
        val usedNames = mutableSetOf<String>()
        val rawOutput = appContext.contentResolver.openOutputStream(destination) ?: error("无法打开保存位置")
        ZipOutputStream(rawOutput).use { zip ->
            readableDatabase.query(
                "media",
                null,
                "role_id = ?",
                arrayOf(roleId.toString()),
                null,
                null,
                "created_at ASC",
            ).use { cursor ->
                while (cursor.moveToNext()) {
                    val file = File(cursor.getString(cursor.getColumnIndexOrThrow("path")))
                    if (!file.isFile) continue
                    var name = cursor.getString(cursor.getColumnIndexOrThrow("name"))
                    val mime = cursor.getString(cursor.getColumnIndexOrThrow("mime"))
                    if (!Regex(".*\\.[A-Za-z0-9]{2,5}$").matches(name)) name += NativeFileRules.extensionForMime(mime)
                    if (!usedNames.add(name)) {
                        name = cursor.getString(cursor.getColumnIndexOrThrow("id")).substring(0, 8) + "-" + name
                    }
                    zip.putNextEntry(ZipEntry(name))
                    FileInputStream(file).use { NativeFiles.copy(it, zip) }
                    zip.closeEntry()
                    exported += 1
                }
            }
        }
        return exported
    }

    fun exportBackup(zip: ZipOutputStream, roleFilter: Set<Long>?): Int {
        var selection: String? = null
        var args: Array<String>? = null
        if (!roleFilter.isNullOrEmpty()) {
            selection = "role_id IN (${roleFilter.joinToString(",") { "?" }})"
            args = roleFilter.map(Long::toString).toTypedArray()
        }
        val files = mutableListOf<Array<String>>()
        zip.putNextEntry(ZipEntry("emoji-index.ndjson"))
        readableDatabase.query("media", null, selection, args, null, null, "created_at ASC").use { cursor ->
            while (cursor.moveToNext()) {
                val id = cursor.getString(cursor.getColumnIndexOrThrow("id"))
                val roleId = cursor.getLong(cursor.getColumnIndexOrThrow("role_id"))
                val file = File(cursor.getString(cursor.getColumnIndexOrThrow("path")))
                if (!file.isFile) continue
                val item = JSONObject()
                    .put("roleId", roleId)
                    .put("file", id)
                    .put("name", cursor.getString(cursor.getColumnIndexOrThrow("name")))
                    .put("mime", cursor.getString(cursor.getColumnIndexOrThrow("mime")))
                    .put("size", cursor.getLong(cursor.getColumnIndexOrThrow("size")))
                    .put("createdAt", cursor.getLong(cursor.getColumnIndexOrThrow("created_at")))
                zip.write((item.toString() + "\n").toByteArray(StandardCharsets.UTF_8))
                files += arrayOf(roleId.toString(), id, file.absolutePath)
            }
        }
        zip.closeEntry()

        var exported = 0
        files.forEach { entry ->
            val file = File(entry[2])
            if (!file.isFile) return@forEach
            zip.putNextEntry(ZipEntry("emoji/${entry[0]}/${entry[1]}"))
            FileInputStream(file).use { NativeFiles.copy(it, zip) }
            zip.closeEntry()
            exported += 1
        }
        return exported
    }

    fun restoreEmojis(staged: List<Array<String>>, metadata: Map<String, JSONObject>): Int {
        if (staged.isEmpty()) return 0
        val database = writableDatabase
        var restored = 0
        database.beginTransaction()
        try {
            staged.forEach { entry ->
                val roleId = entry[0]
                val fileId = entry[1]
                val file = File(entry[2])
                if (!file.isFile) return@forEach
                val info = metadata["$roleId/$fileId"]
                val name = info?.optString("name", NativeFileRules.nameWithoutExtension(fileId))
                    ?: NativeFileRules.nameWithoutExtension(fileId)
                val storedMime = info?.optString("mime", "").orEmpty()
                val mime = storedMime.ifEmpty { NativeFileRules.mimeFromName(fileId) }
                val createdAt = info?.optLong("createdAt", file.lastModified()) ?: file.lastModified()
                val values = ContentValues().apply {
                    put("id", fileId)
                    put("role_id", roleId.toLong())
                    put("name", name)
                    put("mime", mime)
                    put("size", file.length())
                    put("created_at", createdAt)
                    put("path", file.absolutePath)
                }
                database.insertWithOnConflict("media", null, values, SQLiteDatabase.CONFLICT_REPLACE)
                restored += 1
            }
            database.setTransactionSuccessful()
        } finally {
            database.endTransaction()
        }
        return restored
    }
}
