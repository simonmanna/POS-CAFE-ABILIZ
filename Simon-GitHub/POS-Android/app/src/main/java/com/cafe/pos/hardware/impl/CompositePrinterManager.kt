package com.cafe.pos.hardware.impl

import android.content.Context
import com.cafe.pos.hardware.PrinterDevice
import com.cafe.pos.hardware.PrinterManager
import com.cafe.pos.hardware.PrinterPreferences
import com.cafe.pos.hardware.ReceiptPrintJob
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.firstOrNull
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Façade over USB + Bluetooth + Network printers. Discovery merges the
 * first two transports; network printers are added manually by IP via the
 * Settings screen. The most recently used device is persisted in
 * [PrinterPreferences] and auto-reconnected on next launch.
 */
@Singleton
class CompositePrinterManager @Inject constructor(
    private val usb: UsbEscPosPrinter,
    private val bluetooth: BluetoothEscPosPrinter,
    private val network: NetworkEscPosPrinter,
    private val preferences: PrinterPreferences,
) : PrinterManager {

    @Volatile private var activeTransport: PrinterDevice.Transport? = null
    @Volatile private var activeDevice: PrinterDevice? = null

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    init {
        // Auto-reconnect to the last printer so the cashier doesn't re-pick
        // every launch. Failures are silent — the UI shows "no printer".
        scope.launch {
            val last = preferences.lastDevice.firstOrNull() ?: return@launch
            connect(last)
        }
    }

    override suspend fun listAvailable(): List<PrinterDevice> = withContext(Dispatchers.IO) {
        val found = usb.listAvailable() + bluetooth.listAvailable()
        // Surface the last-used device even if it's offline, so the user can
        // see what was selected and reconnect if needed.
        val last = activeDevice ?: preferences.lastDevice.firstOrNull()
        if (last != null && found.none { it.id == last.id }) found + last else found
    }

    override suspend fun connect(device: PrinterDevice): Boolean {
        // Disconnect any prior connection.
        when (activeTransport) {
            PrinterDevice.Transport.USB -> usb.shutdown()
            PrinterDevice.Transport.BLUETOOTH -> bluetooth.disconnect()
            PrinterDevice.Transport.NETWORK -> network.disconnect()
            null -> { /* no prior connection */ }
        }
        activeTransport = null
        activeDevice = null

        val ok = when (device.transport) {
            PrinterDevice.Transport.USB -> usb.connect(device)
            PrinterDevice.Transport.BLUETOOTH -> bluetooth.connect(device)
            PrinterDevice.Transport.NETWORK -> network.connect(device)
        }
        if (ok) {
            activeTransport = device.transport
            activeDevice = device
            preferences.save(device)
        }
        return ok
    }

    override suspend fun printReceipt(job: ReceiptPrintJob): Boolean =
        active()?.printReceipt(job) ?: false

    override suspend fun openCashDrawer(): Boolean =
        active()?.openCashDrawer() ?: false

    override fun isConnected(): Boolean = activeTransport != null

    fun activeDevice(): PrinterDevice? = activeDevice

    private fun active(): PrinterManager? = when (activeTransport) {
        PrinterDevice.Transport.USB -> usb
        PrinterDevice.Transport.BLUETOOTH -> bluetooth
        PrinterDevice.Transport.NETWORK -> network
        else -> null
    }

    /** Closes every transport. Call from the Application's onTerminate or
     *  a Hilt @Singleton scope shutdown hook (not wired today). */
    fun shutdown() {
        usb.shutdown()
        bluetooth.disconnect()
        network.disconnect()
        activeTransport = null
        activeDevice = null
    }
}