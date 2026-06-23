package com.cafe.pos.hardware.impl

import com.cafe.pos.hardware.EscPosBuilder
import com.cafe.pos.hardware.PrinterDevice
import com.cafe.pos.hardware.PrinterManager
import com.cafe.pos.hardware.ReceiptPrintJob
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.io.IOException
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket

/**
 * Network ESC/POS printer (Ethernet / Wi-Fi). Common in cafe chains that
 * standardize on Epson TM-T88VI, Star TSP143IV, or Chinese clones with a
 * built-in network port.
 *
 * Connection is a raw TCP socket to port 9100 (the de-facto standard for
 * raw-mode ESC/POS). No LPR, no IPP, no driver daemon — just bytes in,
 * the printer prints. Discovery is by configured IP (no mDNS / Bonjour
 * to keep the dependency surface small; add it later if needed).
 *
 * The default port (9100) can be overridden by appending `:port` to the
 * device address. The [CompositePrinterManager] saves/loads the address
 * via [com.cafe.pos.hardware.PrinterPreferences].
 */
class NetworkEscPosPrinter : PrinterManager {

    @Volatile private var socket: Socket? = null
    @Volatile private var output: OutputStream? = null
    @Volatile private var currentAddress: String? = null

    /** Returns the list of manually-configured network printers. Discovery by
     *  mDNS / Bonjour is out of scope; users add printers by IP in Settings. */
    override suspend fun listAvailable(): List<PrinterDevice> {
        // The composite manager already knows the saved address. We don't probe
        // the network here; the Settings screen lets the user type an IP and
        // try to connect. Empty list keeps the picker honest.
        return emptyList()
    }

    override suspend fun connect(device: PrinterDevice): Boolean = withContext(Dispatchers.IO) {
        val (host, port) = parseAddress(device.address)
        disconnect()
        val s = Socket()
        val connected = try {
            withTimeoutOrNull(5_000) {
                s.connect(InetSocketAddress(host, port), 5_000)
                true
            } ?: false
        } catch (e: IOException) {
            false
        }
        if (!connected) {
            runCatching { s.close() }
            return@withContext false
        }
        try {
            s.tcpNoDelay = true
            s.soTimeout = 5_000
            val out = s.getOutputStream()
            socket = s
            output = out
            currentAddress = device.address
            true
        } catch (e: IOException) {
            runCatching { s.close() }
            false
        }
    }

    override suspend fun printReceipt(job: ReceiptPrintJob): Boolean = withContext(Dispatchers.IO) {
        val out = output ?: return@withContext false
        val bytes = EscPosBuilder.build(job).toByteArray(Charsets.UTF_8)
        try {
            out.write(bytes)
            out.flush()
            true
        } catch (e: IOException) {
            false
        }
    }

    override suspend fun openCashDrawer(): Boolean = withContext(Dispatchers.IO) {
        val out = output ?: return@withContext false
        try {
            out.write(EscPosBuilder.openDrawer().toByteArray(Charsets.UTF_8))
            out.flush()
            true
        } catch (e: IOException) {
            false
        }
    }

    override fun isConnected(): Boolean = socket?.isConnected == true

    fun disconnect() {
        runCatching { output?.close() }
        runCatching { socket?.close() }
        output = null
        socket = null
        currentAddress = null
    }

    private fun parseAddress(address: String): Pair<String, Int> {
        val parts = address.split(":")
        return if (parts.size == 2) (parts[0] to (parts[1].toIntOrNull() ?: 9100))
        else address to 9100
    }
}