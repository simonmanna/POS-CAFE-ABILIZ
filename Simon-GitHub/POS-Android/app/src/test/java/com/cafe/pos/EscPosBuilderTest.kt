package com.cafe.pos.hardware

import com.cafe.pos.domain.cart.CartStore
import org.junit.Assert.assertTrue
import org.junit.Test

class EscPosBuilderTest {

    @Test fun `builds a non-empty receipt with init and cut`() {
        val job = ReceiptPrintJob(
            storeName = "Cafe POS",
            storeAddress = "123 Test St",
            invoiceNumber = "INV-0001",
            cashier = "alice",
            lines = listOf(ReceiptLine(name = "Espresso", quantity = 2.0, unitPrice = 3.5)),
            subtotal = 7.0,
            discount = 0.0,
            tax = 0.0,
            total = 7.0,
            tendered = 10.0,
            change = 3.0,
            paymentMethod = "cash",
            footer = "Thank you!",
            cutPaper = true,
        )
        val out = EscPosBuilder.build(job)
        assertTrue(out.startsWith(EscPosBuilder.init().trim()))
        assertTrue("Cafe POS" in out)
        assertTrue("INV-0001" in out)
        assertTrue("Espresso" in out)
        assertTrue("TOTAL" in out)
        assertTrue(out.endsWith(EscPosBuilder.cut()))
    }

    @Test fun `renders discount line when present`() {
        val job = ReceiptPrintJob(
            storeName = "Cafe",
            storeAddress = null,
            invoiceNumber = "INV",
            cashier = null,
            lines = listOf(ReceiptLine(name = "Muffin", quantity = 1.0, unitPrice = 4.0, discountPercent = 25.0)),
            subtotal = 4.0,
            discount = 1.0,
            tax = 0.0,
            total = 3.0,
            tendered = 3.0,
            change = 0.0,
            paymentMethod = "cash",
            footer = null,
            cutPaper = false,
        )
        val out = EscPosBuilder.build(job)
        assertTrue("discount 25%" in out)
    }
}