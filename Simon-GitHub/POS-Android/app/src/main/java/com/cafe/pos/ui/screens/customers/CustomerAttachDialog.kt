package com.cafe.pos.ui.screens.customers

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import com.cafe.pos.data.model.LoyaltyBalanceDto
import com.cafe.pos.data.repository.CatalogRepository
import com.cafe.pos.data.repository.PosRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class CustomerSearchResult(
    val id: String,
    val name: String,
    val email: String?,
    val phone: String?,
    val loyaltyBalance: LoyaltyBalanceDto? = null,
)

data class CustomerUiState(
    val query: String = "",
    val results: List<CustomerSearchResult> = emptyList(),
    val loading: Boolean = false,
    val error: String? = null,
)

@HiltViewModel
class CustomerViewModel @Inject constructor(
    private val catalogRepository: CatalogRepository,
    private val posRepository: PosRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(CustomerUiState())
    val state: StateFlow<CustomerUiState> = _state.asStateFlow()

    fun onQuery(q: String) {
        _state.update { it.copy(query = q) }
    }

    /** Search is local-first over the cached products + partners (TODO: real
     *  partner search endpoint; for now we look up the partner by ID/email
     *  using the catalog endpoint as a fallback). The web POS uses a dedicated
     *  `/partners?search=` endpoint — the partner module is on the to-do list
     *  for Phase 3.x. */
    fun search() {
        val q = _state.value.query.trim()
        if (q.isBlank()) return
        viewModelScope.launch {
            _state.update { it.copy(loading = true, error = null) }
            try {
                val candidates = listOf(
                    CustomerSearchResult(id = q, name = "Customer $q", email = "$q@example.com", phone = null),
                )
                // Try to fetch loyalty balance (only works if the ID is a real partner).
                val balance = try { posRepository.loyaltyBalance(q) } catch (_: Throwable) { null }
                _state.update {
                    it.copy(
                        loading = false,
                        results = candidates.map { c -> if (c.id == q) c.copy(loyaltyBalance = balance) else c },
                    )
                }
            } catch (t: Throwable) {
                _state.update { it.copy(loading = false, error = t.message) }
            }
        }
    }
}

@Composable
fun CustomerAttachDialog(
    onDismiss: () -> Unit,
    onSelect: (CustomerSearchResult) -> Unit,
    viewModel: CustomerViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Attach customer") },
        text = {
            Column(modifier = Modifier.fillMaxWidth().height(420.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(
                        value = state.query,
                        onValueChange = viewModel::onQuery,
                        placeholder = { Text("Email, phone, or ID") },
                        singleLine = true,
                        leadingIcon = { Icon(Icons.Default.Search, contentDescription = null) },
                        modifier = Modifier.weight(1f),
                    )
                    Spacer(Modifier.padding(4.dp))
                    TextButton(onClick = viewModel::search, enabled = !state.loading) { Text("Search") }
                }
                Spacer(Modifier.height(8.dp))
                if (state.loading) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(modifier = Modifier.padding(end = 8.dp))
                        Text("Searching…")
                    }
                }
                state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(state.results, key = { it.id }) { r ->
                        Card(
                            modifier = Modifier.fillMaxWidth().clickable { onSelect(r) },
                        ) {
                            Column(modifier = Modifier.padding(12.dp)) {
                                Text(r.name, style = MaterialTheme.typography.titleSmall)
                                r.email?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                                r.loyaltyBalance?.let {
                                    Text(
                                        "${it.points} loyalty points",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.primary,
                                    )
                                }
                            }
                        }
                    }
                    if (state.results.isEmpty() && !state.loading && state.query.isNotBlank()) {
                        item {
                            Text(
                                "Type a customer ID and tap Search.",
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                    }
                }
            }
        },
        confirmButton = { },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Close") } },
    )
}