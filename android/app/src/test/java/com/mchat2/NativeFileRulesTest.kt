package com.mchat2

import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeFileRulesTest {
    @Test
    fun sanitizeFileNameKeepsPortableCharactersAndLengthLimit() {
        assertEquals("角色_头像.png", NativeFileRules.sanitizeFileName("角色 头像.png", 80))
        assertEquals("456789", NativeFileRules.sanitizeFileName("123456789", 6))
    }

    @Test
    fun safeArchiveFileNameRejectsTraversalAndSeparators() {
        assertTrue(NativeFileRules.safeArchiveFileName("角色-01_avatar.webp"))
        assertFalse(NativeFileRules.safeArchiveFileName(".."))
        assertFalse(NativeFileRules.safeArchiveFileName("../outside.png"))
        assertFalse(NativeFileRules.safeArchiveFileName("folder/file.png"))
    }

    @Test
    fun safeArchiveTargetRejectsCanonicalEscape() {
        val root = Files.createTempDirectory("mchat2-archive-policy").toFile()
        try {
            assertThrows(SecurityException::class.java) {
                NativeFileRules.safeArchiveTarget(root, "../outside.png")
            }
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun mediaTypeRulesPreserveExistingBackupCompatibility() {
        assertEquals("image/jpeg", NativeFileRules.mimeFromName("photo.JPEG"))
        assertEquals(".webp", NativeFileRules.extensionForMime("image/webp"))
        assertTrue(NativeFileRules.isSupportedImage("avatar.gif", null))
        assertTrue(NativeFileRules.isZip("backup.bin", "application/zip"))
        assertFalse(NativeFileRules.isSupportedImage("notes.txt", "text/plain"))
    }
}
