package com.cafe.pos.hardware

import com.cafe.pos.domain.cart.CartStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ReceiptBuilderTest {

    @Test fun `round-trips a cart into a receipt with correct totals`() {
        val store = CartStore()
        store.addLine(CartStore.Line(name = "Latte", quantity = 2.0, unitPrice = 4.5))
        store.addLine(CartStore.Line(name = "Croissant", quantity = 1.0, unitPrice = 3.0, discountPercent = 50.0))
        val job = store.state.value.toReceiptJob(
            storeName = "Cafe",
            storeAddress = "1 Main St",
            invoiceNumber = "INV-1",
            cashier = "alice",
            paymentMethod = "cash",
            tendered = 15.0,
            change = 1.5,
        )
        // 2 × 4.5 + 1 × 3.0 × 0.5 = 9.0 + 1.5 = 10.5
        assertEquals(10.5, job.total, 0.0001)
        assertEquals(2, job.lines.size)
        assertEquals("Latte", job.lines[0].name)
        assertEquals("Croissant", job.lines[1].name)
        assertEquals(1.5, job.change, 0.0001)
        assertTrue("expected discount in receipt", job.discount > 0)
    }

    @Test fun `empty cart produces zero-total receipt`() {
        val store = CartStore()
        val job = store.state.value.toReceiptJob(
            storeName = "Cafe", storeAddress = null, invoiceNumber = "INV-0",
            cashier = null, paymentMethod = "cash", tendered = 0.0, change = 0.0,
        )
        assertEquals(0.0, job.total, 0.0001)
        assertEquals(0, job.lines.size)
    }
}