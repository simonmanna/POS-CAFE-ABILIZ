package com.cafe.pos.ui.screens.combos

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Restaurant
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cafe.pos.data.model.ComboDto
import com.cafe.pos.data.repository.PosRepository
import com.cafe.pos.domain.cart.CartStore
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class ComboPickerUiState(
    val combos: List<ComboDto> = emptyList(),
    val loading: Boolean = false,
    val error: String? = null,
)

@HiltViewModel
class ComboPickerViewModel @Inject constructor(
    private val posRepository: PosRepository,
    private val cart: CartStore,
) : ViewModel() {

    private val _state = MutableStateFlow(ComboPickerUiState())
    val state: StateFlow<ComboPickerUiState> = _state.asStateFlow()

    init { load() }

    fun load() {
        viewModelScope.launch {
            _state.update { it.copy(loading = true, error = null) }
            try {
                _state.update { it.copy(loading = false, combos = posRepository.combos()) }
            } catch (t: Throwable) {
                _state.update { it.copy(loading = false, error = t.message) }
            }
        }
    }

    /**
     * Adds a combo to the cart. The combo is recorded as a single [CartStore.Line]
     * with `comboId` set; the server expands it at checkout.
     */
    fun addCombo(combo: ComboDto) {
        cart.addLine(
            CartStore.Line(
                name = combo.name,
                quantity = 1.0,
                unitPrice = combo.price,
                comboId = combo.id,
            )
        )
    }
}

@Composable
fun ComboPickerDialog(
    onDismiss: () -> Unit,
    viewModel: ComboPickerViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.Restaurant, contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary)
                Spacer(Modifier.size(8.dp))
                Text("Combos")
            }
        },
        text = {
            Column(modifier = Modifier.fillMaxWidth().height(420.dp)) {
                if (state.loading) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(modifier = Modifier.size(20.dp))
                        Spacer(Modifier.size(8.dp))
                        Text("Loading…")
                    }
                }
                state.error?.let {
                    Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                }
                if (state.combos.isEmpty() && !state.loading && state.error == null) {
                    Text(
                        "No combos configured for this store.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(state.combos, key = { it.id }) { combo ->
                        ComboCard(combo) { viewModel.addCombo(combo) }
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Done") } },
    )
}

@Composable
private fun ComboCard(combo: ComboDto, onAdd: () -> Unit) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(combo.name, style = MaterialTheme.typography.titleMedium)
                    Text(combo.items.joinToString(" + ") { it.name },
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                AssistChip(
                    onClick = onAdd,
                    label = { Text("K${"%,.0f".format(combo.price)}") },
                    colors = AssistChipDefaults.assistChipColors(
                        containerColor = MaterialTheme.colorScheme.primary,
                        labelColor = MaterialTheme.colorScheme.onPrimary,
                    ),
                )
            }
        }
    }
}