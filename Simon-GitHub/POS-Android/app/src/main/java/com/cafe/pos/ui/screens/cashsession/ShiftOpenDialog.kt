package com.cafe.pos.ui.screens.cashsession

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Calculate
import androidx.compose.material.icons.filled.PowerSettingsNew
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
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
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cafe.pos.data.model.CashRegisterDto
import com.cafe.pos.data.model.CashSessionDto
import com.cafe.pos.data.repository.CashSessionRepository
import com.cafe.pos.domain.session.ShiftSessionStore
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class ShiftOpenUiState(
    val registers: List<CashRegisterDto> = emptyList(),
    val selectedRegisterId: String? = null,
    val openingFloat: String = "0",
    val notes: String = "",
    val loading: Boolean = false,
    val submitting: Boolean = false,
    val error: String? = null,
)

@HiltViewModel
class ShiftOpenViewModel @Inject constructor(
    private val repository: CashSessionRepository,
    private val store: ShiftSessionStore,
) : ViewModel() {

    private val _state = MutableStateFlow(ShiftOpenUiState())
    val state: StateFlow<ShiftOpenUiState> = _state.asStateFlow()

    init { load() }

    fun load() {
        viewModelScope.launch {
            _state.update { it.copy(loading = true, error = null) }
            try {
                val regs = repository.listRegisters(activeOnly = true)
                _state.update {
                    it.copy(
                        loading = false,
                        registers = regs,
                        selectedRegisterId = regs.firstOrNull()?.id,
                    )
                }
            } catch (t: Throwable) {
                _state.update { it.copy(loading = false, error = t.message ?: "Failed to load registers") }
            }
        }
    }

    fun selectRegister(id: String) = _state.update { it.copy(selectedRegisterId = id) }
    fun setFloat(v: String) = _state.update { it.copy(openingFloat = v.filter { c -> c.isDigit() || c == '.' }) }
    fun setNotes(v: String) = _state.update { it.copy(notes = v) }

    fun open(onDone: (CashSessionDto) -> Unit) {
        val s = _state.value
        val regId = s.selectedRegisterId
        if (regId == null) {
            _state.update { it.copy(error = "Pick a cash register") }
            return
        }
        val float = s.openingFloat.toDoubleOrNull()
        if (float == null || float < 0) {
            _state.update { it.copy(error = "Opening float must be a non-negative number") }
            return
        }
        viewModelScope.launch {
            _state.update { it.copy(submitting = true, error = null) }
            try {
                val session = repository.openSession(
                    registerId = regId,
                    openingFloat = float,
                    notes = s.notes.ifBlank { null },
                )
                store.set(session)
                _state.update { it.copy(submitting = false) }
                onDone(session)
            } catch (t: Throwable) {
                _state.update { it.copy(submitting = false, error = t.message ?: "Failed to open shift") }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ShiftOpenDialog(
    onDismiss: () -> Unit,
    onOpened: (CashSessionDto) -> Unit,
    viewModel: ShiftOpenViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()
    LaunchedEffect(Unit) { viewModel.load() }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.PowerSettingsNew, contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary)
                Spacer(Modifier.padding(4.dp))
                Text("Open shift")
            }
        },
        text = {
            Column {
                Text(
                    "Pick the cash register you're working on today and count the opening float.",
                    style = MaterialTheme.typography.bodyMedium,
                )
                Spacer(Modifier.height(12.dp))
                if (state.loading) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(modifier = Modifier.padding(end = 8.dp))
                        Text("Loading registers…")
                    }
                } else if (state.registers.isEmpty()) {
                    Text(
                        "No active cash registers. Ask a manager to create one under Accounting → Cash Registers.",
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall,
                    )
                } else {
                    Text("Cash register", style = MaterialTheme.typography.labelMedium)
                    Spacer(Modifier.height(4.dp))
                    LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        items(state.registers, key = { it.id }) { r ->
                            AssistChip(
                                onClick = { viewModel.selectRegister(r.id) },
                                label = { Text(r.code) },
                                colors = if (state.selectedRegisterId == r.id)
                                    AssistChipDefaults.assistChipColors(
                                        containerColor = MaterialTheme.colorScheme.primary,
                                        labelColor = MaterialTheme.colorScheme.onPrimary,
                                    )
                                else AssistChipDefaults.assistChipColors(),
                            )
                        }
                    }
                    val selected = state.registers.firstOrNull { it.id == state.selectedRegisterId }
                    if (selected != null) {
                        Spacer(Modifier.height(4.dp))
                        Text(selected.name, style = MaterialTheme.typography.bodySmall)
                    }
                    Spacer(Modifier.height(12.dp))
                    Text("Opening float", style = MaterialTheme.typography.labelMedium)
                    Spacer(Modifier.height(4.dp))
                    OutlinedTextField(
                        value = state.openingFloat,
                        onValueChange = viewModel::setFloat,
                        leadingIcon = { Icon(Icons.Default.Calculate, contentDescription = null) },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal, imeAction = ImeAction.Next),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(4.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        listOf(0.0, 50_000.0, 100_000.0, 200_000.0, 500_000.0).forEach { q ->
                            AssistChip(onClick = { viewModel.setFloat(q.toString().substringBefore('.')) },
                                label = { Text(if (q == 0.0) "No float" else q.toInt().toString()) })
                        }
                    }
                    Spacer(Modifier.height(12.dp))
                    OutlinedTextField(
                        value = state.notes,
                        onValueChange = viewModel::setNotes,
                        label = { Text("Notes (optional)") },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                state.error?.let {
                    Spacer(Modifier.height(8.dp))
                    Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                }
            }
        },
        confirmButton = {
            Button(
                enabled = !state.submitting && state.registers.isNotEmpty(),
                onClick = { viewModel.open(onOpened) },
            ) {
                if (state.submitting) CircularProgressIndicator(modifier = Modifier.padding(end = 8.dp).height(16.dp))
                Text(if (state.submitting) "Opening…" else "Open shift")
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}