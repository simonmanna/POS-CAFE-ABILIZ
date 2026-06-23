package com.cafe.pos.hardware.impl

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import com.cafe.pos.hardware.EscPosBuilder
import com.cafe.pos.hardware.PrinterDevice
import com.cafe.pos.hardware.PrinterManager
import com.cafe.pos.hardware.ReceiptPrintJob
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.IOException
import java.util.UUID

/**
 * Bluetooth-connected ESC/POS printer (classic SPP).
 *
 * The standard UUID 00001101-0000-1000-8000-00805F9B34FB is the well-known
 * "Serial Port Profile" UUID most thermal printers expose.
 *
 * On API 31+ we need BLUETOOTH_CONNECT permission at runtime; we silently skip
 * discovery/connection if it isn't granted.
 *
 * Not supported: BLE-only printers. Those need a different GATT write path —
 * see [BleEscPosPrinter] (TODO if/when we have a customer with one).
 */
class BluetoothEscPosPrinter(
    private val context: Context,
) : PrinterManager {

    private val bluetoothManager: BluetoothManager? =
        context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
    private val adapter: BluetoothAdapter? get() = bluetoothManager?.adapter

    @Volatile private var socket: BluetoothSocket? = null
    @Volatile private var currentAddress: String? = null

    private fun hasConnectPermission(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
        return ContextCompat.checkSelfPermission(
            context, Manifest.permission.BLUETOOTH_CONNECT
        ) == PackageManager.PERMISSION_GRANTED
    }

    @SuppressLint("MissingPermission")
    override suspend fun listAvailable(): List<PrinterDevice> = withContext(Dispatchers.IO) {
        if (!hasConnectPermission()) return@withContext emptyList()
        val ad = adapter ?: return@withContext emptyList()
        if (!ad.isEnabled) return@withContext emptyList()
        ad.bondedDevices.orEmpty()
            .filter { device ->
                // Heuristic: most thermal printers identify as "Printer" or contain
                // common model strings. We don't try to be exhaustive — the user picks
                // from this list anyway.
                val name = (device.name ?: "").lowercase()
                name.contains("print") || name.contains("tm-") || name.contains("rp") ||
                name.contains("esc") || name.contains("pos")
            }
            .map { device ->
                PrinterDevice(
                    id = device.address,
                    name = device.name ?: "Bluetooth Printer",
                    transport = PrinterDevice.Transport.BLUETOOTH,
                    address = device.address,
                )
            }
    }

    @SuppressLint("MissingPermission")
    override suspend fun connect(device: PrinterDevice): Boolean = withContext(Dispatchers.IO) {
        if (!hasConnectPermission()) return@withContext false
        val ad = adapter ?: return@withContext false
        if (!ad.isEnabled) return@withContext false
        val dev: BluetoothDevice = try {
            ad.getRemoteDevice(device.address)
        } catch (e: IllegalArgumentException) { return@withContext false }

        // Disconnect any existing socket first.
        runCatching { socket?.close() }
        socket = null
        currentAddress = null

        val sspUuid = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
        val sock = try {
            dev.createRfcommSocketToServiceRecord(sspUuid)
        } catch (e: IOException) { return@withContext false }
        try {
            // Cancel discovery to keep the connection fast.
            ad.cancelDiscovery()
            sock.connect()
            socket = sock
            currentAddress = device.address
            true
        } catch (e: IOException) {
            runCatching { sock.close() }
            false
        }
    }

    override suspend fun printReceipt(job: ReceiptPrintJob): Boolean = withContext(Dispatchers.IO) {
        val s = socket ?: return@withContext false
        val bytes = EscPosBuilder.build(job).toByteArray(Charsets.UTF_8)
        try {
            s.outputStream.write(bytes)
            s.outputStream.flush()
            true
        } catch (e: IOException) {
            false
        }
    }

    override suspend fun openCashDrawer(): Boolean = withContext(Dispatchers.IO) {
        val s = socket ?: return@withContext false
        try {
            s.outputStream.write(EscPosBuilder.openDrawer().toByteArray(Charsets.UTF_8))
            s.outputStream.flush()
            true
        } catch (e: IOException) {
            false
        }
    }

    override fun isConnected(): Boolean = socket?.isConnected == true

    fun disconnect() {
        runCatching { socket?.close() }
        socket = null
        currentAddress = null
    }
}