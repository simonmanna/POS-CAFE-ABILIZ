package com.cafe.pos.ui.screens.checkout

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cafe.pos.data.model.CheckoutResult
import com.cafe.pos.data.model.PaymentTenderDto
import com.cafe.pos.data.repository.PosRepository
import com.cafe.pos.domain.cart.CartStore
import com.cafe.pos.domain.session.ShiftSessionStore
import com.cafe.pos.hardware.ReceiptPrintJob
import com.cafe.pos.hardware.ReceiptLine
import com.cafe.pos.hardware.toReceiptJob
import com.cafe.pos.hardware.PrinterManager
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class CheckoutUiState(
    val paymentMethod: String = "cash",
    val amountTendered: String = "",
    val splitTender: Boolean = false,
    val tenders: List<PaymentTenderDto> = emptyList(),
    val isSubmitting: Boolean = false,
    val error: String? = null,
    val lastResult: CheckoutResult? = null,
    val printStatus: String? = null,
    val loyaltyPointsEarned: Int? = null,
)

@HiltViewModel
class CheckoutViewModel @Inject constructor(
    private val posRepository: PosRepository,
    private val shiftStore: ShiftSessionStore,
    private val printer: PrinterManager,
    private val cartPersistence: com.cafe.pos.data.cart.CartPersistence,
    val cart: CartStore,
) : ViewModel() {

    val cartState: StateFlow<CartStore.State> = cart.state

    private val _state = MutableStateFlow(CheckoutUiState())
    val state: StateFlow<CheckoutUiState> = _state.asStateFlow()

    fun setMethod(m: String) = _state.update { it.copy(paymentMethod = m) }
    fun setTendered(s: String) = _state.update { it.copy(amountTendered = s.filter { c -> c.isDigit() || c == '.' }) }
    fun toggleSplit() = _state.update { it.copy(splitTender = !it.splitTender) }

    fun addTender(method: String, amount: Double) {
        _state.update { it.copy(tenders = it.tenders + PaymentTenderDto(method, amount)) }
    }

    fun removeTender(index: Int) {
        _state.update { it.copy(tenders = it.tenders.filterIndexed { i, _ -> i != index }) }
    }

    fun checkout(onDone: (String) -> Unit) {
        val cart = cartState.value
        if (cart.lines.isEmpty()) {
            _state.update { it.copy(error = "Cart is empty") }
            return
        }
        // Block checkout if no shift is open — the server will reject the
        // request anyway, but failing fast in the UI is a better cashier UX.
        if (shiftStore.current.value == null) {
            _state.update { it.copy(error = "Open a shift before taking sales") }
            return
        }
        viewModelScope.launch {
            _state.update { it.copy(isSubmitting = true, error = null) }
            try {
                val tenders = if (_state.value.splitTender) _state.value.tenders else null
                val tendered = _state.value.amountTendered.toDoubleOrNull()
                // Always pass the active session id — the server ties the sale
                // to it for X/Z reports.
                val sessionId = shiftStore.sessionId()
                val res = posRepository.checkout(
                    lines = this@CheckoutViewModel.cart.toCheckoutLines(),
                    paymentMethod = if (tenders == null) _state.value.paymentMethod else null,
                    amountTendered = tendered,
                    transactionDiscountPercent = cart.transactionDiscountPercent,
                    overrideById = cart.overrideById,
                    cashSessionId = sessionId,
                )
                _state.update { it.copy(isSubmitting = false, lastResult = res) }

                // Auto-print the receipt. We don't fail the checkout if the
                // printer is offline — the sale is already committed and the
                // cashier can re-print from the receipt screen.
                tryPrintReceipt(res, tendered ?: 0.0)

                // Loyalty: if the cart is attached to a partner, award points
                // for the sale. Earn call is fire-and-forget — the cashier sees
                // the points in the success snackbar, and the customer can
                // check their balance at the next attach.
                val partnerId = cart.partnerId
                if (partnerId != null) {
                    try {
                        val newBalance = posRepository.loyaltyEarn(
                            partnerId = partnerId,
                            saleAmount = res.total,
                            invoiceId = res.invoiceId,
                        )
                        _state.update { it.copy(loyaltyPointsEarned = newBalance.points) }
                    } catch (_: Throwable) {
                        // Loyalty is best-effort; don't fail the sale.
                    }
                }

                // If invoiceId starts with PENDING-, the request was queued offline and
                // will reconcile when connectivity returns. The local cart clears either way.
                onDone(res.invoiceId)
                this@CheckoutViewModel.cart.clear()
                // Drop the persisted cart snapshot too — it's served its purpose.
                cartPersistence.clear()
            } catch (t: Throwable) {
                _state.update { it.copy(isSubmitting = false, error = t.message ?: "Checkout failed") }
            }
        }
    }

    /**
     * Redeem loyalty points against this sale. Subtracts the cash total by
     * `points * redeemRate`. The server enforces its own rate; the
     * client's job is to display the new total and let the cashier retry.
     */
    fun redeemPoints(partnerId: String, points: Int) {
        if (points <= 0) return
        viewModelScope.launch {
            try {
                val res = posRepository.loyaltyRedeem(
                    partnerId = partnerId,
                    points = points,
                    invoiceId = null,
                )
                _state.update { it.copy(loyaltyPointsEarned = res.points) }
            } catch (t: Throwable) {
                _state.update { it.copy(error = t.message ?: "Loyalty redeem failed") }
            }
        }
    }

    /**
     * Build the receipt and push it to the active printer. No-ops silently
     * if no printer is connected — the cashier can re-print from the
     * receipt screen.
     */
    private suspend fun tryPrintReceipt(res: CheckoutResult, tendered: Double) {
        if (!printer.isConnected()) {
            _state.update { it.copy(printStatus = "No printer connected") }
            return
        }
        val job = cartState.value.toReceiptJob(
            storeName = "Cafe POS",
            storeAddress = null,
            invoiceNumber = res.invoiceNumber,
            cashier = null,
            paymentMethod = _state.value.paymentMethod,
            tendered = tendered,
            change = (tendered - res.total).coerceAtLeast(0.0),
        )
        val ok = printer.printReceipt(job)
        _state.update { it.copy(printStatus = if (ok) "Receipt printed" else "Print failed") }
    }
}