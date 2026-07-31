package com.mchat2

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal class SecureStorageService(private val context: Context) {
    fun save(key: String, value: String) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, secureStorageKey())
        val encrypted = cipher.doFinal(value.toByteArray(StandardCharsets.UTF_8))
        val encoded = Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" +
            Base64.encodeToString(encrypted, Base64.NO_WRAP)
        preferences().edit().putString(key, encoded).apply()
    }

    fun load(key: String): String? {
        val encoded = preferences().getString(key, null)?.takeIf { it.isNotEmpty() } ?: return null
        val parts = encoded.split(":", limit = 2)
        check(parts.size == 2) { "安全设置格式损坏" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.DECRYPT_MODE,
            secureStorageKey(),
            GCMParameterSpec(128, Base64.decode(parts[0], Base64.DEFAULT)),
        )
        val plain = cipher.doFinal(Base64.decode(parts[1], Base64.DEFAULT))
        return String(plain, StandardCharsets.UTF_8)
    }

    fun clear(key: String) {
        preferences().edit().remove(key).apply()
    }

    private fun preferences(): SharedPreferences =
        context.getSharedPreferences(SECRET_PREFERENCES, Context.MODE_PRIVATE)

    private fun secureStorageKey(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (keyStore.getKey(SECRET_KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(
                SECRET_KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build(),
        )
        return generator.generateKey()
    }

    companion object {
        private const val SECRET_KEY_ALIAS = "mchat2.secure.settings"
        private const val SECRET_PREFERENCES = "mchat2_secure"
        private val VALID_KEY = Regex("[A-Za-z0-9._-]{1,80}")

        fun normalizeKey(key: String?): String? = key?.trim()?.takeIf(VALID_KEY::matches)
    }
}
