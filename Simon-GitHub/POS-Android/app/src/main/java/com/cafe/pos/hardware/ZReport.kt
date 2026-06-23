package com.cafe.pos.hardware

import com.cafe.pos.data.model.CategoryTotal
import com.cafe.pos.data.model.PaymentMethodTotal

/**
 * Z-Report layout — the printer-friendly summary of a closed shift.
 *
 * Mirrors what the web POS sends to its receipt printer at close-shift
 * (see [ShiftCloseDialog.tsx] for the variance UI; this is the text
 * version that goes on paper).
 *
 * Two-pass: header (cashier + register + opening + expected) + per-method
 * breakdown + per-category breakdown + variance.
 */
data class ZReport(
    val storeName: String,
    val storeAddress: String?,
    val invoiceNumber: String,        // often the session id formatted as Z-XXXX
    val cashier: String?,
    val openedAt: String?,
    val closedAt: String?,
    val openingFloat: Double,
    val salesCount: Int,
    val salesTotal: Double,
    val refundsTotal: Double,
    val netSales: Double,
    val overridesTotal: Double,
    val payInsTotal: Double,
    val payOutsTotal: Double,
    val expectedCash: Double,
    val closingCounted: Double?,
    val variance: Double?,
    val byMethod: List<PaymentMethodTotal>,
    val byCategory: List<CategoryTotal>,
    val footer: String? = null,
) {
    fun toReceiptJob(): ReceiptPrintJob {
        val varianceLine = variance?.let {
            when {
                it == 0.0 -> "Variance: balanced"
                it > 0.0 -> "Variance: over by K${"%,.0f".format(it)}"
                else -> "Variance: short by K${"%,.0f".format(-it)}"
            }
        }
        val lines = mutableListOf<ReceiptLine>()
        lines += ReceiptLine("Shift close", 1.0, 0.0, note = "Z-REPORT")
        lines += ReceiptLine("Sales: $salesCount", salesCount.toDouble(), salesTotal)
        lines += ReceiptLine("Refunds", 1.0, refundsTotal)
        lines += ReceiptLine("Net sales", 1.0, netSales)
        byMethod.forEach { m -> lines += ReceiptLine("${m.method} (${m.count})", m.count.toDouble(), m.total.toDoubleOrNull() ?: 0.0) }
        varianceLine?.let { lines += ReceiptLine(it, 1.0, variance ?: 0.0) }

        return ReceiptPrintJob(
            storeName = storeName,
            storeAddress = storeAddress,
            invoiceNumber = invoiceNumber,
            cashier = cashier,
            lines = lines,
            subtotal = salesTotal,
            discount = refundsTotal,
            tax = 0.0,
            total = netSales,
            tendered = closingCounted ?: expectedCash,
            change = (closingCounted ?: expectedCash) - expectedCash,
            paymentMethod = "Z-REPORT",
            footer = footer,
            cutPaper = true,
        )
    }
}