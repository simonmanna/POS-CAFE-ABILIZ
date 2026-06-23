package com.cafe.pos.hardware

import android.content.Context
import com.cafe.pos.domain.cart.CartStore

/**
 * Hardware abstraction layer.
 *
 * On Android tablets, a real POS needs to talk to:
 *   - receipt printers (ESC/POS over USB or Bluetooth)
 *   - barcode scanners (camera-based via ML Kit, or HID keyboard wedge)
 *   - cash drawers (pulse via RJ11 on the printer, or USB GPIO)
 *   - NFC readers (loyalty cards, contactless payments)
 *
 * The web POS doesn't have any of these, so this whole layer is brand-new.
 * Everything is behind interfaces so unit tests and emulators don't need real hardware.
 */

interface PrinterManager {
    suspend fun listAvailable(): List<PrinterDevice>
    suspend fun connect(device: PrinterDevice): Boolean
    suspend fun printReceipt(job: ReceiptPrintJob): Boolean
    suspend fun openCashDrawer(): Boolean
    fun isConnected(): Boolean
}

data class PrinterDevice(
    val id: String,
    val name: String,
    val transport: Transport,
    val address: String,   // USB vendorId:productId or BT MAC
) {
    enum class Transport { USB, BLUETOOTH, NETWORK }
}

data class ReceiptPrintJob(
    val storeName: String,
    val storeAddress: String?,
    val invoiceNumber: String,
    val cashier: String?,
    val lines: List<ReceiptLine>,
    val subtotal: Double,
    val discount: Double,
    val tax: Double,
    val total: Double,
    val tendered: Double,
    val change: Double,
    val paymentMethod: String,
    val footer: String? = null,
    /** Cut the paper after print. */
    val cutPaper: Boolean = true,
)

data class ReceiptLine(
    val name: String,
    val quantity: Double,
    val unitPrice: Double,
    val discountPercent: Double = 0.0,
    val note: String? = null,
)

interface BarcodeScanner {
    suspend fun scan(): String?     // returns barcode or null on cancel
    fun cancel()
}

interface CashDrawer {
    suspend fun open(): Boolean
}

interface NfcReader {
    fun onCardDetected(callback: (cardId: String) -> Unit)
    fun stop()
}

/**
 * Service locator for hardware. Default impls are no-ops so the app runs fine
 * on any device; production wires these to real drivers via Hilt.
 */
class HardwareServices(
    val printer: PrinterManager = NoopPrinter,
    val scanner: BarcodeScanner = NoopScanner,
    val cashDrawer: CashDrawer = NoopCashDrawer,
    val nfc: NfcReader = NoopNfcReader,
)

object NoopPrinter : PrinterManager {
    override suspend fun listAvailable() = emptyList<PrinterDevice>()
    override suspend fun connect(device: PrinterDevice) = false
    override suspend fun printReceipt(job: ReceiptPrintJob) = true
    override suspend fun openCashDrawer() = true
    override fun isConnected() = false
}

object NoopScanner : BarcodeScanner {
    override suspend fun scan(): String? = null
    override fun cancel() {}
}

object NoopCashDrawer : CashDrawer {
    override suspend fun open() = true
}

object NoopNfcReader : NfcReader {
    override fun onCardDetected(callback: (String) -> Unit) {}
    override fun stop() {}
}

/** Helper to format a [CartStore] state as a [ReceiptPrintJob]. */
fun CartStore.State.toReceiptJob(
    storeName: String,
    storeAddress: String?,
    invoiceNumber: String,
    cashier: String?,
    paymentMethod: String,
    tendered: Double,
    change: Double,
    tax: Double = 0.0,
    footer: String? = null,
): ReceiptPrintJob = ReceiptPrintJob(
    storeName = storeName,
    storeAddress = storeAddress,
    invoiceNumber = invoiceNumber,
    cashier = cashier,
    lines = lines.map {
        ReceiptLine(
            name = it.name,
            quantity = it.quantity,
            unitPrice = it.unitPrice,
            discountPercent = it.discountPercent,
            note = it.note,
        )
    },
    subtotal = lines.sumOf { it.quantity * it.unitPrice },
    discount = lines.sumOf { it.quantity * it.unitPrice * (it.discountPercent / 100.0) },
    tax = tax,
    total = maxOf(0.0, lines.sumOf { it.quantity * it.unitPrice * (1 - it.discountPercent / 100.0) }),
    tendered = tendered,
    change = change,
    paymentMethod = paymentMethod,
    footer = footer,
)