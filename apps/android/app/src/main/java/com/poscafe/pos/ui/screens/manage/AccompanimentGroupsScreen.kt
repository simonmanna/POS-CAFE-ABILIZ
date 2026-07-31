package com.poscafe.pos.ui.screens.manage

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.RamenDining
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.poscafe.pos.data.local.dao.MenuDao
import com.poscafe.pos.data.local.entity.AccompanimentGroupEntity
import com.poscafe.pos.data.local.entity.AccompanimentOptionEntity
import com.poscafe.pos.data.repo.CatalogRepository
import com.poscafe.pos.ui.components.EmptyState
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.util.UUID
import javax.inject.Inject

@HiltViewModel
class AccompanimentGroupsViewModel @Inject constructor(
    private val menuDao: MenuDao,
    private val catalog: CatalogRepository,
) : ViewModel() {
    val groups: StateFlow<List<AccompanimentGroupEntity>> =
        menuDao.allAccompanimentGroups().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    suspend fun optionsOf(groupId: String): List<AccompanimentOptionEntity> = menuDao.accompanimentOptions(groupId)

    fun save(group: AccompanimentGroupEntity, options: List<AccompanimentOptionEntity>) =
        viewModelScope.launch { catalog.saveAccompanimentGroup(group, options) }

    fun delete(id: String) = viewModelScope.launch { catalog.deleteAccompanimentGroup(id) }
}

@Composable
fun AccompanimentGroupsScreen(onBack: () -> Unit, vm: AccompanimentGroupsViewModel = hiltViewModel()) {
    val groups by vm.groups.collectAsStateWithLifecycle()
    var editing by remember { mutableStateOf<AccompanimentGroupEntity?>(null) }
    var showAdd by remember { mutableStateOf(false) }

    ManageScaffold(
        title = "Accompaniments",
        onBack = onBack,
        fabLabel = "New group",
        onFab = { showAdd = true },
    ) { _ ->
        if (groups.isEmpty()) {
            EmptyState(
                icon = Icons.Outlined.RamenDining,
                title = "No groups yet",
                subtitle = "Create accompaniment groups (e.g. “Choose a side”) to attach to menu items.",
                modifier = Modifier.fillMaxSize(),
            )
        } else {
            LazyColumn(
                verticalArrangement = Arrangement.spacedBy(8.dp),
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 88.dp),
            ) {
                items(groups, key = { it.id }) { g ->
                    Surface(
                        onClick = { editing = g },
                        shape = MaterialTheme.shapes.large,
                        color = MaterialTheme.colorScheme.surface,
                        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Row(Modifier.padding(horizontal = 14.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(g.name, style = MaterialTheme.typography.titleSmall)
                                Text(
                                    "${if (g.isRequired) "Required" else "Optional"} · pick ${g.minSelect}–${g.maxSelect}",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    if (showAdd || editing != null) {
        AccompanimentGroupEditor(
            existing = editing,
            loadOptions = { vm.optionsOf(it) },
            onSave = { g, opts -> vm.save(g, opts); showAdd = false; editing = null },
            onDelete = editing?.let { g -> { vm.delete(g.id); editing = null } },
            onDismiss = { showAdd = false; editing = null },
        )
    }
}

private data class OptDraft(val id: String, val name: String, val impact: String, val isDefault: Boolean)

@Composable
private fun AccompanimentGroupEditor(
    existing: AccompanimentGroupEntity?,
    loadOptions: suspend (String) -> List<AccompanimentOptionEntity>,
    onSave: (AccompanimentGroupEntity, List<AccompanimentOptionEntity>) -> Unit,
    onDelete: (() -> Unit)?,
    onDismiss: () -> Unit,
) {
    var name by remember { mutableStateOf(existing?.name ?: "") }
    var required by remember { mutableStateOf(existing?.isRequired ?: true) }
    var minSel by remember { mutableStateOf((existing?.minSelect ?: 1).toString()) }
    var maxSel by remember { mutableStateOf((existing?.maxSelect ?: 1).toString()) }
    val opts = remember { mutableStateListOf<OptDraft>() }

    LaunchedEffect(existing?.id) {
        val id = existing?.id ?: return@LaunchedEffect
        opts.clear()
        opts.addAll(loadOptions(id).map { OptDraft(it.id, it.name, "%.0f".format(it.priceImpact), it.isDefault) })
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        shape = MaterialTheme.shapes.extraLarge,
        title = { Text(if (existing == null) "New group" else "Edit group", style = MaterialTheme.typography.headlineSmall) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(value = name, onValueChange = { name = it }, label = { Text("Group name") }, singleLine = true, shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth())
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Text("Required", style = MaterialTheme.typography.bodyMedium)
                    Switch(checked = required, onCheckedChange = { required = it })
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(value = minSel, onValueChange = { minSel = it.filter { c -> c.isDigit() } }, label = { Text("Min") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), shape = MaterialTheme.shapes.medium, modifier = Modifier.weight(1f))
                    OutlinedTextField(value = maxSel, onValueChange = { maxSel = it.filter { c -> c.isDigit() } }, label = { Text("Max") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), shape = MaterialTheme.shapes.medium, modifier = Modifier.weight(1f))
                }
                SectionLabelPublic("Options")
                opts.forEachIndexed { i, o ->
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        OutlinedTextField(value = o.name, onValueChange = { opts[i] = o.copy(name = it) }, label = { Text("Name") }, singleLine = true, shape = MaterialTheme.shapes.medium, modifier = Modifier.weight(1.4f))
                        OutlinedTextField(value = o.impact, onValueChange = { opts[i] = o.copy(impact = it.filter { c -> c.isDigit() || c == '.' }) }, label = { Text("Upcharge") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), shape = MaterialTheme.shapes.medium, modifier = Modifier.weight(1f))
                        IconButton(onClick = { opts.removeAt(i) }) { Icon(Icons.Outlined.Close, "Remove", tint = MaterialTheme.colorScheme.error) }
                    }
                }
                TextButton(onClick = { opts.add(OptDraft(UUID.randomUUID().toString(), "", "0", false)) }) { Text("+ Add option") }
                onDelete?.let { TextButton(onClick = it) { Text("Delete group", color = MaterialTheme.colorScheme.error) } }
            }
        },
        confirmButton = {
            Button(
                enabled = name.isNotBlank(),
                shape = MaterialTheme.shapes.medium,
                onClick = {
                    val id = existing?.id ?: UUID.randomUUID().toString()
                    val group = AccompanimentGroupEntity(
                        id = id, name = name.trim(), isRequired = required,
                        minSelect = minSel.toIntOrNull() ?: 1, maxSelect = maxSel.toIntOrNull() ?: 1,
                        sortOrder = existing?.sortOrder ?: 0, isActive = true,
                    )
                    val entities = opts.mapIndexedNotNull { i, d ->
                        if (d.name.isBlank()) return@mapIndexedNotNull null
                        AccompanimentOptionEntity(id = d.id, groupId = id, name = d.name.trim(), priceImpact = d.impact.toDoubleOrNull() ?: 0.0, isDefault = d.isDefault, sortOrder = i, isActive = true)
                    }
                    onSave(group, entities)
                },
            ) { Text("Save") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
