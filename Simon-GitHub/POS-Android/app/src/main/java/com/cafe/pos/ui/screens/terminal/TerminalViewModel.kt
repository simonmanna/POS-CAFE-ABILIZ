package com.cafe.pos.ui.screens.terminal

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cafe.pos.data.model.CategoryDto
import com.cafe.pos.data.model.ProductDto
import com.cafe.pos.data.repository.CatalogRepository
import com.cafe.pos.domain.cart.CartStore
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class TerminalUiState(
    val products: List<ProductDto> = emptyList(),
    val categories: List<CategoryDto> = emptyList(),
    val selectedCategoryId: String? = null,
    val search: String = "",
    val loading: Boolean = false,
    val error: String? = null,
)

@HiltViewModel
class TerminalViewModel @Inject constructor(
    private val catalogRepository: CatalogRepository,
    private val posRepository: com.cafe.pos.data.repository.PosRepository,
    private val shiftSessionStore: com.cafe.pos.domain.session.ShiftSessionStore,
    private val cashSessionRepository: com.cafe.pos.data.repository.CashSessionRepository,
    val cart: CartStore,
) : ViewModel() {

    private val _ui = MutableStateFlow(TerminalUiState())
    val ui: StateFlow<TerminalUiState> = _ui.asStateFlow()

    val cartState: StateFlow<CartStore.State> = cart.state

    init {
        viewModelScope.launch {
            catalogRepository.cachedProducts.collect { cached ->
                _ui.update { it.copy(products = cached) }
            }
        }
        refresh()
    }

    fun refresh() {
        viewModelScope.launch {
            _ui.update { it.copy(loading = true, error = null) }
            try {
                val products = catalogRepository.refresh(_ui.value.search, _ui.value.selectedCategoryId)
                val cats = products.mapNotNull { p -> p.category?.let { CategoryDto(it.id, it.name) } }
                    .distinctBy { it.id }
                _ui.update { it.copy(loading = false, products = products, categories = cats) }
            } catch (t: Throwable) {
                _ui.update { it.copy(loading = false, error = t.message) }
            }
        }
    }

    fun onSearch(q: String) {
        _ui.update { it.copy(search = q) }
        refresh()
    }

    fun selectCategory(id: String?) {
        _ui.update { it.copy(selectedCategoryId = id) }
        refresh()
    }

    fun addProduct(p: ProductDto) {
        cart.addProduct(p)
    }

    fun setQuantity(lineId: String, qty: Double) = cart.setQuantity(lineId, qty)
    fun removeLine(lineId: String) = cart.removeLine(lineId)
    fun clearCart() = cart.clear()

    /** Called from the barcode scanner. Looks up the SKU on the server (or in
     *  the cache) and adds the first match to the cart. */
    fun lookupAndAddBySku(sku: String) {
        viewModelScope.launch {
            val product = catalogRepository.lookupSku(sku)
            if (product != null) cart.addProduct(product)
            else _ui.update { it.copy(error = "Unknown SKU: $sku") }
        }
    }

    /** Hold the current cart to the server and clear the local cart. */
    fun holdCurrentCart(name: String, notes: String?) {
        viewModelScope.launch {
            try {
                posRepository.createHold(
                    name = name, lines = cart.toCheckoutLines(), notes = notes,
                )
                cart.clear()
            } catch (t: Throwable) {
                _ui.update { it.copy(error = t.message ?: "Hold failed") }
            }
        }
    }

    /** Re-fetch the currently-open cash session. The banner observes [ShiftSessionStore]
     *  and updates automatically. */
    fun refreshActiveShift() {
        viewModelScope.launch {
            try {
                shiftSessionStore.set(cashSessionRepository.activeSession())
            } catch (_: Throwable) {
                // Network blip — leave the previous value alone.
            }
        }
    }
}