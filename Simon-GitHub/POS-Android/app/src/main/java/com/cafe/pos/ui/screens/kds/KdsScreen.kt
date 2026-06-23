package com.cafe.pos.ui.screens.kds

import androidx.compose.foundation.background
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cafe.pos.data.model.KdsTicketDto
import com.cafe.pos.data.repository.PosRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class KdsUiState(
    val tickets: List<KdsTicketDto> = emptyList(),
    val error: String? = null,
)

@HiltViewModel
class KdsViewModel @Inject constructor(
    private val posRepository: PosRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(KdsUiState())
    val state: StateFlow<KdsUiState> = _state.asStateFlow()

    init {
        viewModelScope.launch {
            // Track which ticket ids we've already auto-claimed so we don't
            // spam the server. Cleared when the ticket leaves the list.
            val autoClaimed = mutableSetOf<String>()
            while (true) {
                try {
                    val tickets = posRepository.kdsTickets()
                    tickets.filter { it.status == "queued" && it.id !in autoClaimed }
                        .forEach { t ->
                            autoClaimed += t.id
                            runCatching { posRepository.kdsTransition(t.id, "in_progress") }
                        }
                    autoClaimed.retainAll(tickets.map { it.id }.toSet())
                    _state.update { it.copy(tickets = posRepository.kdsTickets(), error = null) }
                } catch (t: Throwable) {
                    _state.update { it.copy(error = t.message) }
                }
                delay(5_000)
            }
        }
    }

    fun transition(ticket: KdsTicketDto, newStatus: String) {
        viewModelScope.launch {
            try {
                posRepository.kdsTransition(ticket.id, newStatus)
                _state.update { it.copy(tickets = it.tickets.map { t -> if (t.id == ticket.id) t.copy(status = newStatus) else t }) }
            } catch (t: Throwable) {
                _state.update { it.copy(error = t.message) }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun KdsScreen(
    viewModel: KdsViewModel = hiltViewModel(),
    onBack: () -> Unit,
) {
    val state by viewModel.state.collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Kitchen Display") },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.primary,
                    titleContentColor = MaterialTheme.colorScheme.onPrimary,
                    navigationIconContentColor = MaterialTheme.colorScheme.onPrimary,
                ),
            )
        },
    ) { padding ->
        Column(modifier = Modifier.padding(padding).fillMaxSize()) {
            state.error?.let {
                Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp))
            }
            LazyColumn(
                modifier = Modifier.padding(16.dp).fillMaxSize(),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                items(state.tickets, key = { it.id }) { ticket ->
                    Card(modifier = Modifier.fillMaxWidth()) {
                        Column(modifier = Modifier.padding(12.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text("#${ticket.orderId.takeLast(6)}", style = MaterialTheme.typography.titleMedium)
                                Spacer(Modifier.weight(1f))
                                Text(ticket.status.uppercase(), style = MaterialTheme.typography.labelMedium)
                            }
                            ticket.tableNumber?.let { Text("Table $it", style = MaterialTheme.typography.bodySmall) }
                            Spacer(Modifier.height(8.dp))
                            ticket.lines.forEach { line ->
                                Text("• ${line.quantity.toInt()} × ${line.description}", style = MaterialTheme.typography.bodyMedium)
                                line.note?.let { Text("  note: ${it}", style = MaterialTheme.typography.bodySmall) }
                            }
                            Spacer(Modifier.height(8.dp))
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                if (ticket.status == "queued") Button(onClick = { viewModel.transition(ticket, "in_progress") }) { Text("Start") }
                                if (ticket.status == "in_progress") Button(onClick = { viewModel.transition(ticket, "ready") }) { Text("Ready") }
                                if (ticket.status == "ready") Button(onClick = { viewModel.transition(ticket, "done") }) { Text("Done") }
                            }
                        }
                    }
                }
            }
        }
    }
}