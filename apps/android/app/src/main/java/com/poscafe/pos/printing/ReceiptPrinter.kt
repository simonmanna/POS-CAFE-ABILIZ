package com.poscafe.pos.printing

import com.poscafe.pos.data.repo.CartEngine
import com.poscafe.pos.data.repo.SaleRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.InetSocketAddress
import java.net.Socket
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Direct-from-device printing. Offline (away from the LAN server that
 * normally owns printing) the device drives the thermal printer itself over
 * TCP 9100; Bluetooth SPP can be added as a second transport behind the same
 * `send` seam.
 *
 * Offline tickets print the provisional number and an explicit OFFLINE
 * marker; reprints after sync use the final invoice number.
 */
@Singleton
class ReceiptPrinter @Inject constructor() {

    private val timeFmt = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm").withZone(ZoneId.systemDefault())

    suspend fun printReceipt(
        host: String,
        port: Int = 9100,
        header: List<String>,
        sale: SaleRepository.CompletedSale,
        lines: List<CartEngine.CartLine>,
        tenders: List<SaleRepository.Tender>,
        cashierName: String,
        offline: Boolean,
        finalNumber: String? = null,
        footer: String = "Thank you!",
        reprint: Boolean = false,
    ) {
        val t = EscPos()
        t.init().alignCenter().doubleSize(true)
        header.firstOrNull()?.let { t.line(it) }
        t.doubleSize(false)
        header.drop(1).forEach { t.center(it) }
        t.alignLeft().rule()
        t.pair("Receipt", finalNumber ?: sale.provisionalNumber)
        if (reprint) t.center("*** REPRINT ***")
        if (offline && finalNumber == null) t.center("*** OFFLINE — number provisional ***")
        t.pair("Date", timeFmt.format(sale.occurredAt))
        t.pair("Cashier", cashierName)
        t.rule()
        val totals = sale.totals
        for (line in lines) {
            val lt = totals.lines[line.lineId] ?: continue
            t.item(fmtQty(line.quantity), line.name + (line.variantName?.let { " ($it)" } ?: ""), fmt(lt.net))
            line.modifiers.forEach { m -> t.line("    + ${m.name}") }
            line.accompaniments.forEach { a -> t.line("    + ${a.name}") }
        }
        t.rule()
        t.pair("Subtotal", fmt(totals.subtotal))
        if (totals.discountTotal > 0) t.pair("Discount", "-" + fmt(totals.discountTotal))
        t.pair("Tax", fmt(totals.taxTotal))
        t.bold(true).pair("TOTAL", fmt(totals.total)).bold(false)
        tenders.forEach { t.pair("  ${it.method}", fmt(it.amount)) }
        val change = tenders.sumOf { it.amount } - totals.total
        if (change > 0.004) t.pair("  change", fmt(change))
        t.rule().alignCenter().line(footer).cut()

        send(host, port, t.bytes())
    }

    suspend fun printKot(
        host: String,
        port: Int = 9100,
        title: String,
        lines: List<CartEngine.CartLine>,
        note: String? = null,
    ) {
        val t = EscPos()
        t.init().alignCenter().doubleSize(true).line("KITCHEN").doubleSize(false)
        t.center(title).alignLeft().rule()
        for (line in lines) {
            t.doubleSize(true).line("${fmtQty(line.quantity)} x ${line.name}").doubleSize(false)
            line.variantName?.let { t.line("    $it") }
            line.modifiers.forEach { m -> t.line("    + ${m.name}") }
            line.accompaniments.forEach { a -> t.line("    + ${a.name}") }
            line.note?.let { t.line("    NOTE: $it") }
        }
        note?.let { t.rule().line(it) }
        t.cut()
        send(host, port, t.bytes())
    }

    private suspend fun send(host: String, port: Int, payload: ByteArray) = withContext(Dispatchers.IO) {
        Socket().use { socket ->
            socket.connect(InetSocketAddress(host, port), 4_000)
            socket.getOutputStream().apply {
                write(payload)
                flush()
            }
        }
    }

    private fun fmt(v: Double): String = "%,.0f".format(v)
    private fun fmtQty(q: Double): String = if (q % 1.0 == 0.0) q.toInt().toString() else q.toString()
}
