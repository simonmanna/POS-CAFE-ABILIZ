package com.cafe.pos.hardware

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import javax.inject.Inject
import javax.inject.Singleton

private val Context.printerPrefs by preferencesDataStore(name = "printer_prefs")

/**
 * Remembers the last-connected printer so the cashier doesn't re-pick it on
 * every launch. The composite manager reads [lastDevice] on init and attempts
 * to reconnect.
 */
@Singleton
class PrinterPreferences @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    private val idKey = stringPreferencesKey("printer_id")
    private val nameKey = stringPreferencesKey("printer_name")
    private val transportKey = stringPreferencesKey("printer_transport")
    private val addressKey = stringPreferencesKey("printer_address")

    val lastDevice: Flow<PrinterDevice?> = context.printerPrefs.data.map { prefs ->
        val id = prefs[idKey] ?: return@map null
        val name = prefs[nameKey] ?: return@map null
        val transport = prefs[transportKey]?.let { runCatching { PrinterDevice.Transport.valueOf(it) }.getOrNull() }
            ?: return@map null
        val address = prefs[addressKey] ?: return@map null
        PrinterDevice(id = id, name = name, transport = transport, address = address)
    }

    suspend fun save(device: PrinterDevice) {
        context.printerPrefs.edit { prefs ->
            prefs[idKey] = device.id
            prefs[nameKey] = device.name
            prefs[transportKey] = device.transport.name
            prefs[addressKey] = device.address
        }
    }

    suspend fun clear() {
        context.printerPrefs.edit { it.clear() }
    }
}