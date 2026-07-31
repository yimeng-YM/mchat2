package com.mchat2

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.provider.Settings
import android.speech.RecognizerIntent
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import java.util.Locale
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

@CapacitorPlugin(
    name = "DeviceFeatures",
    permissions = [Permission(alias = "notifications", strings = [Manifest.permission.POST_NOTIFICATIONS])],
)
class DeviceFeaturesPlugin : Plugin() {
    private val ioScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private lateinit var attachments: AttachmentService
    private lateinit var notifications: NotificationService
    private lateinit var secureStorage: SecureStorageService

    override fun load() {
        attachments = AttachmentService(context)
        notifications = NotificationService(context)
        secureStorage = SecureStorageService(context)
    }

    @PluginMethod
    fun pickImage(call: PluginCall) {
        val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            Intent(MediaStore.ACTION_PICK_IMAGES)
        } else {
            Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
        }.setType("image/*")
        startActivityForResult(call, intent, "pickImageResult")
    }

    @PluginMethod
    fun readImageDataUrl(call: PluginCall) {
        val rawUri = call.getString("uri", "") ?: ""
        val maxDimension = call.getInt("maxDimension", 1600) ?: 1600
        val quality = call.getInt("quality", 82) ?: 82
        ioScope.launch {
            try {
                call.resolve(JSObject().put("dataUrl", attachments.readImageDataUrl(rawUri, maxDimension, quality)))
            } catch (error: Exception) {
                call.reject("无法准备发送图片", error)
            }
        }
    }

    @ActivityCallback
    private fun pickImageResult(call: PluginCall, result: ActivityResult) {
        val source = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || source == null) {
            call.resolve(JSObject().put("cancelled", true))
            return
        }
        val roleId = call.getLong("roleId", 0L) ?: 0L
        ioScope.launch {
            try {
                val attachment = attachments.importImage(source, roleId)
                call.resolve(
                    JSObject()
                        .put("id", attachment.id)
                        .put("kind", "image")
                        .put("name", attachment.name)
                        .put("mime", attachment.mime)
                        .put("size", attachment.size)
                        .put("uri", attachment.uri),
                )
            } catch (error: Exception) {
                call.reject("导入图片失败", error)
            }
        }
    }

    @PluginMethod
    fun startSpeech(call: PluginCall) {
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.SIMPLIFIED_CHINESE.toLanguageTag())
            .putExtra(RecognizerIntent.EXTRA_PROMPT, "请说话")
        try {
            startActivityForResult(call, intent, "speechResult")
        } catch (error: Exception) {
            call.reject("当前设备没有可用的语音识别服务", error)
        }
    }

    @ActivityCallback
    private fun speechResult(call: PluginCall, result: ActivityResult) {
        if (result.resultCode != Activity.RESULT_OK || result.data == null) {
            call.resolve(JSObject().put("cancelled", true))
            return
        }
        val matches = result.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)
        call.resolve(JSObject().put("text", matches?.firstOrNull().orEmpty()))
    }

    @PluginMethod
    fun requestNotifications(call: PluginCall) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            getPermissionState("notifications") == PermissionState.GRANTED
        ) {
            call.resolve(JSObject().put("granted", true))
            return
        }
        requestPermissionForAlias("notifications", call, "notificationPermissionResult")
    }

    @PluginMethod
    fun checkNotifications(call: PluginCall) {
        val granted = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            getPermissionState("notifications") == PermissionState.GRANTED
        call.resolve(JSObject().put("granted", granted))
    }

    @PluginMethod
    fun openAppSettings(call: PluginCall) {
        val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
            .setData(Uri.fromParts("package", context.packageName, null))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        call.resolve()
    }

    @PermissionCallback
    private fun notificationPermissionResult(call: PluginCall) {
        call.resolve(JSObject().put("granted", getPermissionState("notifications") == PermissionState.GRANTED))
    }

    @PluginMethod
    fun clearNotifications(call: PluginCall) {
        notifications.clear(call.getLong("roleId"))
        call.resolve()
    }

    @PluginMethod
    fun notify(call: PluginCall) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            getPermissionState("notifications") != PermissionState.GRANTED
        ) {
            call.reject("通知权限尚未开启")
            return
        }
        try {
            notifications.show(
                roleId = call.getLong("roleId", 0L) ?: 0L,
                title = call.getString("title", "MChat2") ?: "MChat2",
                body = call.getString("body", "收到一条新消息") ?: "收到一条新消息",
                avatarDataUrl = call.getString("avatarDataUrl"),
            )
            call.resolve()
        } catch (error: Exception) {
            call.reject(error.message ?: "系统通知服务不可用", error)
        }
    }

    @PluginMethod
    fun getPendingNotificationOpen(call: PluginCall) {
        val roleId = notifications.consumeRoleId(activity?.intent)
        call.resolve(JSObject().apply { if (roleId > 0) put("roleId", roleId) })
    }

    override fun handleOnNewIntent(intent: Intent) {
        super.handleOnNewIntent(intent)
        activity?.intent = intent
        val roleId = notifications.consumeRoleId(intent)
        if (roleId > 0) notifyListeners("notificationOpened", JSObject().put("roleId", roleId), true)
    }

    @PluginMethod
    fun saveSecret(call: PluginCall) {
        val key = SecureStorageService.normalizeKey(call.getString("key", ""))
        if (key == null) {
            call.reject("无效的安全存储键")
            return
        }
        try {
            secureStorage.save(key, call.getString("value", "") ?: "")
            call.resolve()
        } catch (error: Exception) {
            call.reject("无法保存安全设置", error)
        }
    }

    @PluginMethod
    fun loadSecret(call: PluginCall) {
        val key = SecureStorageService.normalizeKey(call.getString("key", ""))
        if (key == null) {
            call.reject("无效的安全存储键")
            return
        }
        try {
            call.resolve(JSObject().apply { secureStorage.load(key)?.let { put("value", it) } })
        } catch (error: Exception) {
            call.reject("无法读取安全设置", error)
        }
    }

    @PluginMethod
    fun clearSecret(call: PluginCall) {
        val key = SecureStorageService.normalizeKey(call.getString("key", ""))
        if (key == null) {
            call.reject("无效的安全存储键")
            return
        }
        secureStorage.clear(key)
        call.resolve()
    }

    @PluginMethod
    fun removeRoleFiles(call: PluginCall) {
        val roleId = call.getLong("roleId", 0L) ?: 0L
        ioScope.launch {
            attachments.removeRoleFiles(roleId)
            call.resolve()
        }
    }

    override fun handleOnDestroy() {
        ioScope.cancel()
        super.handleOnDestroy()
    }
}
