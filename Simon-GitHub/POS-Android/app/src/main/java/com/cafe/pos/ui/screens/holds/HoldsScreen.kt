package com.cafe.pos.ui.screens.holds

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Cancel
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cafe.pos.data.model.PosHoldDto
import com.cafe.pos.data.repository.PosRepository
import com.cafe.pos.domain.cart.CartStore
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class HoldsUiState(
    val holds: List<PosHoldDto> = emptyList(),
    val loading: Boolean = false,
    val error: String? = null,
)

@HiltViewModel
class HoldsViewModel @Inject constructor(
    private val posRepository: PosRepository,
    private val cart: CartStore,
) : ViewModel() {

    private val _state = MutableStateFlow(HoldsUiState())
    val state: StateFlow<HoldsUiState> = _state.asStateFlow()

    init { refresh() }

    fun refresh() {
        viewModelScope.launch {
            _state.update { it.copy(loading = true, error = null) }
            try {
                _state.update { it.copy(loading = false, holds = posRepository.listHolds("open")) }
            } catch (t: Throwable) {
                _state.update { it.copy(loading = false, error = t.message) }
            }
        }
    }

    fun recall(hold: PosHoldDto) {
        viewModelScope.launch {
            try {
                posRepository.recallHold(hold.id)
                cart.load(hold.lines.map { l ->
                    CartStore.Line(
                        productId = l.productId,
                        name = l.description,
                        quantity = l.quantity.toDoubleOrNull() ?: 1.0,
                        unitPrice = l.unitPrice.toDoubleOrNull() ?: 0.0,
                        discountPercent = l.discountPercent.toDoubleOrNull() ?: 0.0,
                        taxId = l.taxId,
                        note = l.note,
                    )
                })
                refresh()
            } catch (t: Throwable) {
                _state.update { it.copy(error = t.message) }
            }
        }
    }

    fun cancel(hold: PosHoldDto) {
        viewModelScope.launch {
            try {
                posRepository.cancelHold(hold.id)
                refresh()
            } catch (t: Throwable) {
                _state.update { it.copy(error = t.message) }
            }
        }
    }

    fun holdCurrentCart(name: String, notes: String?) {
        viewModelScope.launch {
            try {
                posRepository.createHold(
                    name = name, lines = cart.toCheckoutLines(), notes = notes,
                )
                cart.clear()
            } catch (t: Throwable) {
                _state.update { it.copy(error = t.message) }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HoldsScreen(
    viewModel: HoldsViewModel = hiltViewModel(),
    onBack: () -> Unit,
) {
    val state by viewModel.state.collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Held orders") },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
                },
                actions = {
                    IconButton(onClick = viewModel::refresh) { Icon(Icons.Default.Refresh, contentDescription = "Refresh") }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.primary,
                    titleContentColor = MaterialTheme.colorScheme.onPrimary,
                    navigationIconContentColor = MaterialTheme.colorScheme.onPrimary,
                    actionIconContentColor = MaterialTheme.colorScheme.onPrimary,
                ),
            )
        },
    ) { padding ->
        Column(modifier = Modifier.padding(padding).fillMaxSize()) {
            state.error?.let {
                Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp))
            }
            if (state.holds.isEmpty() && !state.loading) {
                Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text("No held orders", style = MaterialTheme.typography.bodyLarge)
                }
            }
            LazyColumn(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(state.holds, key = { it.id }) { hold ->
                    Card(modifier = Modifier.fillMaxWidth()) {
                        Column(modifier = Modifier.padding(12.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(hold.name, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                                Text("K${hold.totalAmount}", style = MaterialTheme.typography.titleMedium)
                            }
                            Text("${hold.lines.size} line(s) • ${hold.createdAt}", style = MaterialTheme.typography.bodySmall)
                            Row(
                                modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                                horizontalArrangement = Arrangement.End,
                            ) {
                                TextButton(onClick = { viewModel.cancel(hold) }) {
                                    Icon(Icons.Default.Cancel, contentDescription = null)
                                    Text("Cancel")
                                }
                                TextButton(onClick = { viewModel.recall(hold) }) {
                                    Icon(Icons.Default.Refresh, contentDescription = null)
                                    Text("Recall")
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}