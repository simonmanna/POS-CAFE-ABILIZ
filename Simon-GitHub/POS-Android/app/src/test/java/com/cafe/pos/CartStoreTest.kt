package com.cafe.pos.domain.cart

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Direct port of the cart-store behavior in apps/web/src/features/pos/cart.store.ts.
 * If you change one, change the other.
 */
class CartStoreTest {

    private fun product(id: String = "p1", sku: String? = null, price: String = "10.00") = com.cafe.pos.data.model.ProductDto(
        id = id, code = id.uppercase(), sku = sku, name = "Product $id", salesPrice = price, isActive = true,
    )

    @Test fun `adding same product merges quantity`() {
        val store = CartStore()
        store.addProduct(product("p1"))
        store.addProduct(product("p1"))
        assertEquals(2.0, store.state.value.lines.first().quantity, 0.0001)
        assertEquals(1, store.state.value.lines.size)
    }

    @Test fun `adding different products keeps separate lines`() {
        val store = CartStore()
        store.addProduct(product("p1"))
        store.addProduct(product("p2"))
        assertEquals(2, store.state.value.lines.size)
    }

    @Test fun `tax inclusive flag keeps lines separate`() {
        val store = CartStore()
        store.addLine(CartStore.Line(name = "X", quantity = 1.0, unitPrice = 10.0, taxInclusive = false))
        store.addLine(CartStore.Line(name = "X", quantity = 1.0, unitPrice = 10.0, taxInclusive = true))
        assertEquals(2, store.state.value.lines.size)
    }

    @Test fun `setQuantity zero removes line`() {
        val store = CartStore()
        store.addProduct(product("p1"))
        val line = store.state.value.lines.first()
        store.setQuantity(line.lineId, 0.0)
        assertTrue(store.state.value.lines.isEmpty())
    }

    @Test fun `subtotal applies per-line discount`() {
        val store = CartStore()
        store.addLine(CartStore.Line(name = "X", quantity = 2.0, unitPrice = 10.0, discountPercent = 50.0))
        assertEquals(10.0, store.subtotal(), 0.0001)  // 2 × 10 × 0.5 = 10
    }

    @Test fun `transaction discount caps at 100 percent`() {
        val store = CartStore()
        store.addLine(CartStore.Line(name = "X", quantity = 1.0, unitPrice = 10.0))
        store.setTransactionDiscount(150.0)
        assertEquals(100.0, store.state.value.transactionDiscountPercent, 0.0001)
    }

    @Test fun `total never goes below zero`() {
        val store = CartStore()
        store.addLine(CartStore.Line(name = "X", quantity = 1.0, unitPrice = 10.0))
        store.setTransactionDiscount(200.0)  // capped at 100
        assertTrue(store.total() >= 0.0)
    }

    @Test fun `clear empties state`() {
        val store = CartStore()
        store.addProduct(product("p1"))
        store.clear()
        assertTrue(store.state.value.lines.isEmpty())
    }

    @Test fun `two ad-hoc lines with no product id do not merge`() {
        val store = CartStore()
        store.addLine(CartStore.Line(name = "Custom A", quantity = 1.0, unitPrice = 1.0))
        store.addLine(CartStore.Line(name = "Custom B", quantity = 1.0, unitPrice = 1.0))
        assertEquals(2, store.state.value.lines.size)
    }
}