package com.cafe.pos.domain.cart

import com.cafe.pos.data.model.CheckoutLineDto
import com.cafe.pos.data.model.ProductDto
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.math.max
import kotlin.math.min

/**
 * Cart store — direct port of `apps/web/src/features/pos/cart.store.ts` (zustand).
 *
 * State + behavior are kept in lockstep with the web client so the two UIs share the
 * same business rules:
 *   - merging by (productId|sku) + taxInclusive flag
 *   - transaction-level discount capped at 100%
 *   - line discount capped at 100%
 *
 * Persistence is intentionally in-memory only (no sessionStorage equivalent here).
 * On Android, process death without an explicit clear is rare; if it becomes a
 * problem we'll add DataStore-backed persistence behind the same interface.
 */
@Singleton
class CartStore @Inject constructor() {

    data class Line(
        val lineId: String = UUID.randomUUID().toString(),
        val productId: String? = null,
        val sku: String? = null,
        val name: String,
        val quantity: Double,
        val unitPrice: Double,
        val discountPercent: Double = 0.0,
        val taxId: String? = null,
        val note: String? = null,
        val comboId: String? = null,
        val taxInclusive: Boolean = false,
    )

    data class State(
        val lines: List<Line> = emptyList(),
        val transactionDiscountPercent: Double = 0.0,
        val overrideById: String? = null,
        val cashSessionId: String? = null,
        val partnerId: String? = null,
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    /* ----- Selectors ----- */

    fun subtotal(): Double = _state.value.lines.sumOf {
        it.quantity * it.unitPrice * (1 - it.discountPercent / 100.0)
    }

    fun transactionDiscountAmount(): Double =
        subtotal() * (_state.value.transactionDiscountPercent / 100.0)

    fun total(): Double = max(0.0, subtotal() - transactionDiscountAmount())

    /** Total number of items in the cart (sum of line quantities, rounded down). */
    fun itemCount(): Int = _state.value.lines.sumOf { it.quantity.toInt() }

    /** Direct counters avoid double-mapping. */
    fun totalQuantity(): Double = _state.value.lines.sumOf { it.quantity }

    /* ----- Mutations ----- */

    fun addLine(line: Line) {
        val current = _state.value
        // Only merge when the line is anchored to a product (or SKU). Two ad-hoc
        // "Line"s with no anchor must never collapse — that would silently swallow
        // the cashier's tap on a second distinct product.
        val anchor = line.productId ?: line.sku?.lowercase()
        val existing = if (anchor != null) {
            val key = anchor + (if (line.taxInclusive) "|incl" else "")
            current.lines.find {
                val otherAnchor = it.productId ?: it.sku?.lowercase() ?: return@find false
                (otherAnchor + (if (it.taxInclusive) "|incl" else "")) == key
            }
        } else null
        _state.value = if (existing != null) {
            current.copy(lines = current.lines.map {
                if (it.lineId == existing.lineId) it.copy(quantity = it.quantity + (line.quantity.takeIf { q -> q > 0 } ?: 1.0)) else it
            })
        } else {
            current.copy(lines = current.lines + line.copy(
                lineId = line.lineId.ifBlank { UUID.randomUUID().toString() },
                discountPercent = line.discountPercent,
            ))
        }
    }

    fun addProduct(product: ProductDto, quantity: Double = 1.0) {
        val price = product.salesPrice?.toDoubleOrNull() ?: return
        addLine(
            Line(
                productId = product.id,
                sku = product.sku,
                name = product.name,
                quantity = quantity,
                unitPrice = price,
            )
        )
    }

    /**
     * Restore a cart from disk. Called by [com.cafe.pos.data.cart.CartPersistence]
     * at app start. New line ids are minted so two restores never collide.
     */
    fun loadFromPersistence(
        lines: List<com.cafe.pos.data.model.CheckoutLineDto>,
        transactionDiscountPercent: Double,
        partnerId: String?,
    ) {
        val restored = lines.map { dto ->
            Line(
                productId = dto.productId,
                sku = dto.sku,
                name = dto.description,
                quantity = dto.quantity,
                unitPrice = dto.unitPrice,
                discountPercent = dto.discountPercent,
                taxId = dto.taxId,
                note = dto.note,
                comboId = dto.comboId,
            )
        }
        _state.value = State(
            lines = restored,
            transactionDiscountPercent = transactionDiscountPercent,
            overrideById = null,
            cashSessionId = null,  // must re-check via ShiftSessionStore
            partnerId = partnerId,
        )
    }

    fun setQuantity(lineId: String, qty: Double) {
        val clamped = max(0.0, qty)
        _state.value = _state.value.copy(
            lines = _state.value.lines
                .map { if (it.lineId == lineId) it.copy(quantity = clamped) else it }
                .filter { it.quantity > 0 }
        )
    }

    fun setDiscount(lineId: String, percent: Double) {
        val clamped = max(0.0, min(100.0, percent))
        _state.value = _state.value.copy(
            lines = _state.value.lines.map {
                if (it.lineId == lineId) it.copy(discountPercent = clamped) else it
            }
        )
    }

    fun setNote(lineId: String, note: String) {
        _state.value = _state.value.copy(
            lines = _state.value.lines.map {
                if (it.lineId == lineId) it.copy(note = note) else it
            }
        )
    }

    fun removeLine(lineId: String) {
        _state.value = _state.value.copy(
            lines = _state.value.lines.filter { it.lineId != lineId }
        )
    }

    fun setTransactionDiscount(percent: Double) {
        val clamped = max(0.0, min(100.0, percent))
        _state.value = _state.value.copy(transactionDiscountPercent = clamped)
    }

    fun setOverrideById(id: String?) {
        _state.value = _state.value.copy(overrideById = id)
    }

    fun setCashSession(id: String?) {
        _state.value = _state.value.copy(cashSessionId = id)
    }

    /** Attach (or clear) the loyalty customer on the cart. */
    fun setPartner(partnerId: String?) {
        _state.value = _state.value.copy(partnerId = partnerId)
    }

    /** Wholesale replace (used when recalling a hold). */
    fun load(lines: List<Line>) {
        _state.value = State(lines = lines, transactionDiscountPercent = 0.0, overrideById = null)
    }

    fun clear() {
        _state.value = State()
    }

    fun toCheckoutLines(): List<CheckoutLineDto> = _state.value.lines.map { line ->
        CheckoutLineDto(
            productId = line.productId,
            sku = line.sku,
            description = line.name,
            quantity = line.quantity,
            unitPrice = line.unitPrice,
            taxId = line.taxId,
            discountPercent = line.discountPercent,
            note = line.note,
            comboId = line.comboId,
        )
    }
}