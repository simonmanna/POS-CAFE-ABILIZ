package com.poscafe.pos

import com.poscafe.pos.data.repo.CartEngine
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Pricing parity tests. The named cases mirror the server's folding rules;
 * golden vectors exported from the server (scripts/export-cart-vectors.ts)
 * extend this file once P1 verification runs.
 */
class CartEngineTest {

    private fun line(
        base: Double,
        qty: Double = 1.0,
        discount: Double = 0.0,
        taxRate: Double = 0.0,
        inclusive: Boolean = false,
        modifiers: List<CartEngine.ModifierSel> = emptyList(),
        accompaniments: List<CartEngine.AccompanimentSel> = emptyList(),
    ) = CartEngine.CartLine(
        lineId = "l1",
        menuItemId = "m1",
        name = "Test",
        quantity = qty,
        baseUnitPrice = base,
        discountPercent = discount,
        taxRatePercent = taxRate,
        taxInclusive = inclusive,
        modifiers = modifiers,
        accompaniments = accompaniments,
    )

    @Test
    fun `simple line, no tax`() {
        val t = CartEngine.totals(listOf(line(5000.0, qty = 2.0)))
        assertEquals(10000.0, t.total, 0.001)
        assertEquals(0.0, t.taxTotal, 0.001)
    }

    @Test
    fun `exclusive VAT 18 added on top`() {
        val t = CartEngine.totals(listOf(line(10000.0, taxRate = 18.0)))
        assertEquals(1800.0, t.taxTotal, 0.001)
        assertEquals(11800.0, t.total, 0.001)
    }

    @Test
    fun `inclusive VAT 18 backed out, total unchanged`() {
        val t = CartEngine.totals(listOf(line(11800.0, taxRate = 18.0, inclusive = true)))
        assertEquals(11800.0, t.total, 0.001)
        assertEquals(1800.0, t.taxTotal, 0.01)
    }

    @Test
    fun `modifier delta and accompaniment upcharge fold into unit`() {
        val t = CartEngine.totals(
            listOf(
                line(
                    8000.0,
                    modifiers = listOf(CartEngine.ModifierSel("x", "Extra shot", 1000.0)),
                    accompaniments = listOf(CartEngine.AccompanimentSel("y", "Fries", 1500.0)),
                ),
            ),
        )
        assertEquals(10500.0, t.total, 0.001)
    }

    @Test
    fun `line discount before transaction discount`() {
        // 10000, 10% line discount → 9000; 10% tx discount → 8100
        val t = CartEngine.totals(listOf(line(10000.0, discount = 10.0)), transactionDiscountPercent = 10.0)
        assertEquals(8100.0, t.total, 0.001)
    }

    @Test
    fun `minor to major conversion for menu base price`() {
        assertEquals(85.0, CartEngine.basePriceToMajor(8500.0)!!, 0.001)
    }
}
