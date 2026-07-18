package com.poscafe.pos.data

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import dagger.hilt.android.qualifiers.ApplicationContext
import java.security.SecureRandom
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Device-local secrets + settings, stored in EncryptedSharedPreferences whose
 * master key lives in the Android Keystore (hardware-backed where available):
 *   - serverUrl      LAN and/or cloud base URL, e.g. http://192.168.1.10:3000/api/v1/
 *   - deviceId/token from /sync/devices/register (token shown once by server)
 *   - prefix         provisional-number prefix, e.g. "D1"
 *   - dbPassphrase   SQLCipher key (generated on first run)
 *   - saleCounter    monotonic counter behind provisional numbers
 */
@Singleton
class DeviceConfig @Inject constructor(@ApplicationContext context: Context) {

    private val prefs = EncryptedSharedPreferences.create(
        context,
        "pos-device-config",
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    var serverUrl: String?
        get() = prefs.getString("serverUrl", null)
        set(v) = prefs.edit().putString("serverUrl", v).apply()

    var deviceId: String?
        get() = prefs.getString("deviceId", null)
        set(v) = prefs.edit().putString("deviceId", v).apply()

    var deviceToken: String?
        get() = prefs.getString("deviceToken", null)
        set(v) = prefs.edit().putString("deviceToken", v).apply()

    var prefix: String
        get() = prefs.getString("prefix", "D?") ?: "D?"
        set(v) = prefs.edit().putString("prefix", v).apply()

    var printerHost: String?
        get() = prefs.getString("printerHost", null)
        set(v) = prefs.edit().putString("printerHost", v).apply()

    /** Standalone mode: the app is the whole system — no server, no sync. */
    var standalone: Boolean
        get() = prefs.getBoolean("standalone", false)
        set(v) = prefs.edit().putBoolean("standalone", v).apply()

    // ---- business profile (receipt header/footer) ----
    var businessName: String
        get() = prefs.getString("businessName", "POS CAFE") ?: "POS CAFE"
        set(v) = prefs.edit().putString("businessName", v).apply()

    var businessAddress: String?
        get() = prefs.getString("businessAddress", null)
        set(v) = prefs.edit().putString("businessAddress", v).apply()

    var businessTin: String?
        get() = prefs.getString("businessTin", null)
        set(v) = prefs.edit().putString("businessTin", v).apply()

    var receiptFooter: String
        get() = prefs.getString("receiptFooter", "Thank you!") ?: "Thank you!"
        set(v) = prefs.edit().putString("receiptFooter", v).apply()

    /** Lines printed at the top of every receipt. */
    fun receiptHeader(): List<String> = buildList {
        add(businessName)
        businessAddress?.takeIf { it.isNotBlank() }?.let { add(it) }
        businessTin?.takeIf { it.isNotBlank() }?.let { add("TIN: $it") }
    }

    val isEnrolled: Boolean get() = !deviceToken.isNullOrBlank() && !serverUrl.isNullOrBlank()

    /** Ready to sell: either enrolled against a server or set up standalone. */
    val isReady: Boolean get() = isEnrolled || standalone

    /** SQLCipher passphrase — generated once, never leaves the device. */
    fun dbPassphrase(): ByteArray {
        val existing = prefs.getString("dbPassphrase", null)
        if (existing != null) return existing.toByteArray(Charsets.UTF_8)
        val bytes = ByteArray(32)
        SecureRandom().nextBytes(bytes)
        val encoded = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
        prefs.edit().putString("dbPassphrase", encoded).apply()
        return encoded.toByteArray(Charsets.UTF_8)
    }

    /** Next provisional number, e.g. D1-000042. */
    @Synchronized
    fun nextProvisionalNumber(): String {
        val next = prefs.getLong("saleCounter", 0L) + 1
        prefs.edit().putLong("saleCounter", next).apply()
        return "%s-%06d".format(prefix, next)
    }

    /** Revocation wipe: forget enrollment (DB wipe is handled by the caller). */
    fun clearEnrollment() {
        prefs.edit().remove("deviceId").remove("deviceToken").remove("prefix").apply()
    }
}
