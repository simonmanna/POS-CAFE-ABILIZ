package com.cafe.pos.ui.screens.modifiers

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cafe.pos.data.model.ModifierDto
import com.cafe.pos.data.model.ModifierGroupDto
import com.cafe.pos.data.repository.PosRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class ModifierSheetState(
    val groups: List<ModifierGroupDto> = emptyList(),
    val loading: Boolean = false,
    val error: String? = null,
)

/** What the caller should add to a cart line as a result of the dialog. */
data class ModifierSelection(
    val modifierIds: List<String>,
    val priceDelta: Double,
)

@HiltViewModel
class ModifierSheetViewModel @Inject constructor(
    private val posRepository: PosRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(ModifierSheetState())
    val state: StateFlow<ModifierSheetState> = _state.asStateFlow()

    init { load() }

    fun load() {
        viewModelScope.launch {
            _state.update { it.copy(loading = true, error = null) }
            try {
                val groups = posRepository.modifierGroups()
                _state.update { it.copy(loading = false, groups = groups) }
            } catch (t: Throwable) {
                _state.update { it.copy(loading = false, error = t.message) }
            }
        }
    }
}

@Composable
fun ModifierSheet(
    onDismiss: () -> Unit,
    onConfirm: (ModifierSelection) -> Unit,
    viewModel: ModifierSheetViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()
    // selected modifier ids, in display order.
    val selected = remember { mutableStateListOf<String>() }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Choose modifiers") },
        text = {
            Column(modifier = Modifier.fillMaxWidth().height(420.dp)) {
                if (state.loading) Text("Loading…")
                state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                if (state.groups.isEmpty() && !state.loading) {
                    Text("No modifier groups configured.",
                        style = MaterialTheme.typography.bodyMedium)
                }
                LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(state.groups, key = { it.id }) { group ->
                        ModifierGroupCard(
                            group = group,
                            selected = selected,
                        )
                    }
                }
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    val totalDelta = state.groups
                        .flatMap { it.modifiers }
                        .filter { it.id in selected }
                        .sumOf { it.priceDelta }
                    onConfirm(ModifierSelection(selected.toList(), totalDelta))
                },
            ) { Text("Add") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun ModifierGroupCard(
    group: ModifierGroupDto,
    selected: MutableList<String>,
) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(12.dp)) {
            Text(
                group.name + if (group.required) " (required)" else "",
                style = MaterialTheme.typography.titleSmall,
            )
            if (group.multiSelect) {
                Text("Select up to ${group.maxSelect}",
                    style = MaterialTheme.typography.bodySmall)
            }
            Spacer(Modifier.height(4.dp))
            group.modifiers.forEach { mod ->
                ModifierRow(modifier = mod, selected = mod.id in selected) {
                    if (group.multiSelect) {
                        if (mod.id in selected) selected.remove(mod.id) else selected.add(mod.id)
                    } else {
                        // Single-select: clear others in this group, then add this one.
                        group.modifiers.forEach { selected.remove(it.id) }
                        selected.add(mod.id)
                    }
                }
            }
        }
    }
}

@Composable
private fun ModifierRow(
    modifier: ModifierDto,
    selected: Boolean,
    onToggle: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Checkbox(checked = selected, onCheckedChange = { onToggle() })
        Column(modifier = Modifier.weight(1f)) {
            Text(modifier.name, style = MaterialTheme.typography.bodyMedium)
            if (modifier.priceDelta != 0.0) {
                Text(
                    if (modifier.priceDelta > 0) "+K%.2f".format(modifier.priceDelta)
                    else "K%.2f".format(modifier.priceDelta),
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
    }
}