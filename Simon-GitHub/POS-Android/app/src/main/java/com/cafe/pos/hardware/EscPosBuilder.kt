package com.cafe.pos.hardware

/**
 * ESC/POS command builder. Pure Kotlin — no Android dependencies — so it's easy
 * to unit-test. Real printer driver implementations live in [hardware.impl].
 */
object EscPosBuilder {

    private const val ESC = "\u001B"
    private const val GS = "\u001D"

    fun init(): String = "$ESC@"
    fun alignCenter(): String = "$ESC a 1"
    fun alignLeft(): String = "$ESC a 0"
    fun bold(on: Boolean): String = "$ESC E ${if (on) 1 else 0}"
    fun doubleSize(on: Boolean): String = "$GS ! ${if (on) "17" else "0"}"
    fun feed(lines: Int = 1): String = "$ESC d $lines"
    fun cut(): String = "$GS V 1"
    fun openDrawer(): String = "$ESC p 0 25 250"

    /** 42-char wide receipt — common default for 80mm thermal printers at 12pt. */
    fun build(job: ReceiptPrintJob, width: Int = 42): String = buildString {
        append(init())
        append(alignCenter())
        append(bold(true)).append(doubleSize(true))
        appendLine(job.storeName)
        append(doubleSize(false))
        if (!job.storeAddress.isNullOrBlank()) appendLine(job.storeAddress)
        append(bold(false)).append(alignLeft())

        appendLine("-".repeat(width))
        appendLine("Invoice: ${job.invoiceNumber}")
        if (!job.cashier.isNullOrBlank()) appendLine("Cashier: ${job.cashier}")
        appendLine("-".repeat(width))

        for (line in job.lines) {
            appendLine(line.name.take(width))
            val qtyPrice = "${fmtQty(line.quantity)} x ${fmtMoney(line.unitPrice)}"
            val lineTotal = fmtMoney(line.quantity * line.unitPrice)
            append(padLeft(qtyPrice, width - lineTotal.length)).appendLine(lineTotal)
            if (line.discountPercent > 0) {
                val disc = "  discount ${fmtPct(line.discountPercent)}"
                val discAmt = "-" + fmtMoney(line.quantity * line.unitPrice * line.discountPercent / 100.0)
                append(padLeft(disc, width - discAmt.length)).appendLine(discAmt)
            }
            if (!line.note.isNullOrBlank()) appendLine("  note: ${line.note}")
        }

        appendLine("-".repeat(width))
        append(padLeft("Subtotal", width - fmtMoney(job.subtotal).length)).appendLine(fmtMoney(job.subtotal))
        if (job.discount > 0) {
            append(padLeft("Discount", width - fmtMoney(job.discount).length)).appendLine("-" + fmtMoney(job.discount))
        }
        if (job.tax > 0) {
            append(padLeft("Tax", width - fmtMoney(job.tax).length)).appendLine(fmtMoney(job.tax))
        }
        append(bold(true))
        append(padLeft("TOTAL", width - fmtMoney(job.total).length)).appendLine(fmtMoney(job.total))
        append(bold(false))

        appendLine("Paid via: ${job.paymentMethod}")
        append(padLeft("Tendered", width - fmtMoney(job.tendered).length)).appendLine(fmtMoney(job.tendered))
        append(padLeft("Change", width - fmtMoney(job.change).length)).appendLine(fmtMoney(job.change))

        appendLine(feed(2))
        if (!job.footer.isNullOrBlank()) {
            append(alignCenter()).appendLine(job.footer).append(alignLeft())
        }
        append(feed(3))
        if (job.cutPaper) append(cut())
    }

    private fun String.padRight(total: Int): String = if (length >= total) this else " ".repeat(total - length) + this
    private fun padLeft(left: String, total: Int) = left + " ".repeat((total - left.length).coerceAtLeast(0))

    private fun fmtMoney(d: Double): String = "%.2f".format(d)
    private fun fmtQty(q: Double): String = if (q == q.toInt().toDouble()) q.toInt().toString() else "%.2f".format(q)
    private fun fmtPct(p: Double): String = "%.0f%%".format(p)
}