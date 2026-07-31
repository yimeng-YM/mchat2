package com.mchat2

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.os.Build
import android.util.Base64
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.graphics.drawable.IconCompat

internal class NotificationService(private val context: Context) {
    fun clear(roleId: Long?) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        if (roleId == null) manager.cancelAll() else manager.cancel(notificationId(roleId))
    }

    fun show(roleId: Long, title: String, body: String, avatarDataUrl: String?) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
            ?: error("系统通知服务不可用")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "角色回复", NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = "角色完成回复时的本地提醒"
                },
            )
        }

        val launch = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(ROLE_EXTRA, roleId)
        }
        val pendingIntent = PendingIntent.getActivity(
            context,
            notificationId(roleId),
            launch,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_email)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
        val avatar = decodeDataUrlBitmap(avatarDataUrl)
        if (avatar != null) {
            val user = Person.Builder().setName("你").build()
            val sender = Person.Builder().setName(title).setIcon(IconCompat.createWithBitmap(avatar)).build()
            notification.setLargeIcon(avatar).setStyle(
                NotificationCompat.MessagingStyle(user).addMessage(body, System.currentTimeMillis(), sender),
            )
        } else {
            notification.setStyle(NotificationCompat.BigTextStyle().bigText(body))
        }
        manager.notify(notificationId(roleId), notification.build())
    }

    fun consumeRoleId(intent: Intent?): Long {
        if (intent == null || !intent.hasExtra(ROLE_EXTRA)) return 0L
        return intent.getLongExtra(ROLE_EXTRA, 0L).also { intent.removeExtra(ROLE_EXTRA) }
    }

    private fun decodeDataUrlBitmap(dataUrl: String?) = try {
        val comma = dataUrl?.indexOf(',') ?: -1
        if (comma < 0) null
        else Base64.decode(dataUrl!!.substring(comma + 1), Base64.DEFAULT).let { bytes ->
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        }
    } catch (_: Exception) {
        null
    }

    companion object {
        private const val CHANNEL_ID = "mchat2_replies"
        private const val ROLE_EXTRA = "mchat2.notification.roleId"

        fun notificationId(roleId: Long): Int = ((roleId xor (roleId ushr 32)) and 0x7fffffffL).toInt()
    }
}
