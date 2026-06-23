package com.cafe.pos.hardware

import com.cafe.pos.domain.cart.CartStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.charset.Charset

/**
 * End-to-end test of the receipt pipeline: build a [CartStore.State] via the
 * real mutations, run it through [EscPosBuilder], and verify the resulting
 * byte stream contains all the expected fields and a paper-cut command.
 *
 * Catches regressions in: cart math, builder formatting, init/cut commands.
 */
class ReceiptPipelineTest {

    private fun buildBytes(cart: CartStore): ByteArray {
        val job = cart.state.value.toReceiptJob(
            storeName = "Sunrise Cafe",
            storeAddress = "1 Main St, Cape Town",
            invoiceNumber = "INV-${System.currentTimeMillis() % 10000}",
            cashier = "alice",
            paymentMethod = "cash",
            tendered = 50.0,
            change = 50.0 - cart.total(),
        )
        return EscPosBuilder.build(job).toByteArray(Charset.forName("UTF-8"))
    }

    @Test fun `full cart produces a receipt with init and cut and all lines`() {
        val cart = CartStore()
        cart.addLine(CartStore.Line(name = "Flat White", quantity = 2.0, unitPrice = 4.5))
        cart.addLine(CartStore.Line(name = "Almond Croissant", quantity = 1.0, unitPrice = 3.5, discountPercent = 10.0))
        cart.addLine(CartStore.Line(name = "Sparkling Water", quantity = 3.0, unitPrice = 2.0, note = "no ice"))

        val bytes = buildBytes(cart)
        val str = String(bytes, Charset.forName("UTF-8"))
        // Header
        assertTrue("missing init (ESC @)", str.contains(EscPosBuilder.init().trim()))
        assertTrue("store name not in receipt", "Sunrise Cafe" in str)
        // Lines
        assertTrue("Flat White missing", "Flat White" in str)
        assertTrue("Almond Croissant missing", "Almond Croissant" in str)
        assertTrue("discount line missing", "discount 10%" in str)
        assertTrue("line note missing", "no ice" in str)
        // Totals
        assertTrue("TOTAL marker missing", "TOTAL" in str)
        assertTrue("Tendered marker missing", "Tendered" in str)
        // Trailer
        assertTrue("missing paper cut (GS V 1)", str.endsWith(EscPosBuilder.cut()))
    }

    @Test fun `cart totals are correct after discount`() {
        val cart = CartStore()
        // 2 × 4.5 + 1 × 3.5 × 0.9 = 9.0 + 3.15 = 12.15
        cart.addLine(CartStore.Line(name = "Flat White", quantity = 2.0, unitPrice = 4.5))
        cart.addLine(CartStore.Line(name = "Almond Croissant", quantity = 1.0, unitPrice = 3.5, discountPercent = 10.0))
        assertEquals(12.15, cart.total(), 0.0001)
    }

    @Test fun `transaction discount reduces total`() {
        val cart = CartStore()
        cart.addLine(CartStore.Line(name = "X", quantity = 1.0, unitPrice = 100.0))
        cart.setTransactionDiscount(20.0)
        // 100 × 0.8 = 80
        assertEquals(80.0, cart.total(), 0.0001)
    }

    @Test fun `cash drawer pulse command is the expected ESC p bytes`() {
        val pulse = EscPosBuilder.openDrawer()
        // ESC p 0 25 250 — pin 0, on-time 25ms, off-time 250ms (the de-facto spec value).
        assertEquals("\u001B p 0 25 250", pulse)
    }

    @Test fun `receipt size is reasonable for 50 lines`() {
        val cart = CartStore()
        repeat(50) { i ->
            cart.addLine(CartStore.Line(name = "Item $i", quantity = 1.0, unitPrice = 1.0))
        }
        val bytes = buildBytes(cart)
        // ~50 chars/line + header/footer → well under 4 KB.
        assertTrue("receipt too large: ${bytes.size} bytes", bytes.size in 1000..4096)
    }
}