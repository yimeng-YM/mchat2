package com.mchat2

import com.getcapacitor.PluginMethod
import org.junit.Assert.assertEquals
import org.junit.Test

class PluginContractTest {
    @Test
    fun deviceFeaturesBridgeMethodsRemainStable() {
        assertEquals(
            setOf(
                "pickImage",
                "readImageDataUrl",
                "startSpeech",
                "requestNotifications",
                "checkNotifications",
                "openAppSettings",
                "clearNotifications",
                "notify",
                "getPendingNotificationOpen",
                "saveSecret",
                "loadSecret",
                "clearSecret",
                "removeRoleFiles",
            ),
            pluginMethods(DeviceFeaturesPlugin::class.java),
        )
    }

    @Test
    fun largeMediaBridgeMethodsRemainStable() {
        assertEquals(
            setOf(
                "pickAndImport",
                "list",
                "remove",
                "rename",
                "stats",
                "removeRole",
                "beginTextExport",
                "appendTextExport",
                "saveTextExport",
                "exportRolePack",
                "assembleBackup",
                "pickBackup",
            ),
            pluginMethods(LargeMediaPlugin::class.java),
        )
    }

    private fun pluginMethods(type: Class<*>): Set<String> = type.declaredMethods
        .filter { it.isAnnotationPresent(PluginMethod::class.java) }
        .mapTo(mutableSetOf()) { it.name }
}
