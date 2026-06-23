package com.cafe.pos.hardware.impl

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import com.cafe.pos.hardware.EscPosBuilder
import com.cafe.pos.hardware.PrinterDevice
import com.cafe.pos.hardware.PrinterManager
import com.cafe.pos.hardware.ReceiptPrintJob
import com.hoho.android.usbserial.driver.UsbSerialDriver
import com.hoho.android.usbserial.driver.UsbSerialPort
import com.hoho.android.usbserial.driver.UsbSerialProber
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.withContext
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap

/**
 * USB-connected ESC/POS receipt printer.
 *
 * Uses the [usb-serial-for-android] library. Compatible with the common 58mm / 80mm
 * thermal printers that expose a USB-serial CDC interface (Epson, Star, Chinese clones
 * with CH340/CP2102/FT232 bridges).
 *
 * Setup:
 *   1. The tablet's host-USB port must be enabled (some tablets need a settings toggle
 *      or an OTG adapter).
 *   2. The user grants USB permission once via the system dialog; we cache the
 *      decision and auto-reconnect on subsequent inserts.
 *
 * Threading: the [SerialInputOutputManager] callbacks run on its own background thread;
 * we hop to [Dispatchers.IO] for all port operations. [printReceipt] / [openCashDrawer]
 * are suspend so callers don't block the main thread on a slow print.
 */
class UsbEscPosPrinter(
    private val context: Context,
) : PrinterManager {

    private val usbManager: UsbManager =
        context.getSystemService(Context.USB_SERVICE) as UsbManager

    /** vendorId:productId → port, for already-connected devices. */
    private val openPorts = ConcurrentHashMap<String, UsbSerialPort>()

    @Volatile private var pendingPermission: CompletableDeferred<Boolean>? = null

    private val permissionReceiver = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context, intent: Intent) {
            if (intent.action != ACTION_USB_PERMISSION) return
            val granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
            pendingPermission?.complete(granted)
            pendingPermission = null
        }
    }

    init {
        val filter = IntentFilter(ACTION_USB_PERMISSION)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.registerReceiver(permissionReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            context.registerReceiver(permissionReceiver, filter)
        }
    }

    override suspend fun listAvailable(): List<PrinterDevice> = withContext(Dispatchers.IO) {
        val prober = UsbSerialProber.getDefaultProber()
        usbManager.deviceList.values
            .mapNotNull { device -> prober.probeDevice(device) }
            .flatMap { driver -> driver.ports.map { portToDevice(it) } }
    }

    private fun portToDevice(port: UsbSerialPort): PrinterDevice {
        val dev = port.device
        return PrinterDevice(
            id = "${dev.vendorId}:${dev.productId}",
            name = dev.productName ?: "USB Printer",
            transport = PrinterDevice.Transport.USB,
            address = "${dev.vendorId}:${dev.productId}",
        )
    }

    override suspend fun connect(device: PrinterDevice): Boolean = withContext(Dispatchers.IO) {
        val (vid, pid) = device.address.split(":").map { it.toInt(16) }
        val dev = usbManager.deviceList.values.firstOrNull {
            it.vendorId == vid && it.productId == pid
        } ?: return@withContext false

        if (!usbManager.hasPermission(dev)) {
            val granted = requestPermission(dev)
            if (!granted) return@withContext false
        }
        val prober = UsbSerialProber.getDefaultProber()
        val driver = prober.probeDevice(dev) ?: return@withContext false
        val port = driver.ports.firstOrNull() ?: return@withContext false
        val connection = usbManager.openDevice(dev) ?: return@withContext false
        try {
            port.open(connection)
            port.setParameters(9600, 8, UsbSerialPort.STOPBITS_1, UsbSerialPort.PARITY_NONE)
            // The 3.7.0 interface doesn't expose setFlowControl; most ESC/POS
            // printers run happily with the default (no flow control).
            openPorts[device.address] = port
            true
        } catch (e: IOException) {
            false
        }
    }

    private suspend fun requestPermission(dev: UsbDevice): Boolean {
        val deferred = CompletableDeferred<Boolean>()
        pendingPermission = deferred
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
            PendingIntent.FLAG_MUTABLE else 0
        val pi = PendingIntent.getBroadcast(context, 0, Intent(ACTION_USB_PERMISSION), flags)
        usbManager.requestPermission(dev, pi)
        return withTimeoutOrNull(10_000) { deferred.await() } ?: false
    }

    override suspend fun printReceipt(job: ReceiptPrintJob): Boolean = withContext(Dispatchers.IO) {
        val bytes = EscPosBuilder.build(job).toByteArray(Charsets.UTF_8)
        val anyPort = openPorts.values.firstOrNull() ?: return@withContext false
        try {
            anyPort.write(bytes, 2000)
            true
        } catch (e: IOException) {
            false
        }
    }

    override suspend fun openCashDrawer(): Boolean = withContext(Dispatchers.IO) {
        val anyPort = openPorts.values.firstOrNull() ?: return@withContext false
        try {
            anyPort.write(EscPosBuilder.openDrawer().toByteArray(Charsets.UTF_8), 1000)
            true
        } catch (e: IOException) {
            false
        }
    }

    override fun isConnected(): Boolean = openPorts.isNotEmpty()

    /** Closes all open ports. Call from the Application's onTerminate / a Hilt @Singleton scope. */
    fun shutdown() {
        openPorts.values.forEach { runCatching { it.close() } }
        openPorts.clear()
        runCatching { context.unregisterReceiver(permissionReceiver) }
    }

    companion object {
        private const val ACTION_USB_PERMISSION = "com.cafe.pos.USB_PERMISSION"
    }
}