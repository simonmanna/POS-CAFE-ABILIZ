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
import androidx.compose.material.icons.outlined.Tune
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
import com.poscafe.pos.data.local.entity.ModifierEntity
import com.poscafe.pos.data.local.entity.ModifierGroupEntity
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
class ModifierGroupsViewModel @Inject constructor(
    private val menuDao: MenuDao,
    private val catalog: CatalogRepository,
) : ViewModel() {
    val groups: StateFlow<List<ModifierGroupEntity>> =
        menuDao.allModifierGroups().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    suspend fun modifiersOf(groupId: String): List<ModifierEntity> = menuDao.modifiers(groupId)

    fun save(group: ModifierGroupEntity, modifiers: List<ModifierEntity>) =
        viewModelScope.launch { catalog.saveModifierGroup(group, modifiers) }

    fun delete(id: String) = viewModelScope.launch { catalog.deleteModifierGroup(id) }
}

@Composable
fun ModifierGroupsScreen(onBack: () -> Unit, vm: ModifierGroupsViewModel = hiltViewModel()) {
    val groups by vm.groups.collectAsStateWithLifecycle()
    var editing by remember { mutableStateOf<ModifierGroupEntity?>(null) }
    var showAdd by remember { mutableStateOf(false) }

    ManageScaffold(
        title = "Add-ons & modifiers",
        onBack = onBack,
        fabLabel = "New group",
        onFab = { showAdd = true },
    ) { _ ->
        if (groups.isEmpty()) {
            EmptyState(
                icon = Icons.Outlined.Tune,
                title = "No groups yet",
                subtitle = "Create add-on/modifier groups (e.g. “Extras”, “Milk”) to attach to menu items.",
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
                                    "${if (g.groupType == "MODIFIER") "Modifier" else "Add-on"} · pick ${g.minSelect}–${g.maxSelect}",
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
        ModifierGroupEditor(
            existing = editing,
            loadModifiers = { vm.modifiersOf(it) },
            onSave = { g, mods -> vm.save(g, mods); showAdd = false; editing = null },
            onDelete = editing?.let { g -> { vm.delete(g.id); editing = null } },
            onDismiss = { showAdd = false; editing = null },
        )
    }
}

private data class ModDraft(val id: String, val name: String, val delta: String, val isDefault: Boolean)

@Composable
private fun ModifierGroupEditor(
    existing: ModifierGroupEntity?,
    loadModifiers: suspend (String) -> List<ModifierEntity>,
    onSave: (ModifierGroupEntity, List<ModifierEntity>) -> Unit,
    onDelete: (() -> Unit)?,
    onDismiss: () -> Unit,
) {
    var name by remember { mutableStateOf(existing?.name ?: "") }
    var isModifier by remember { mutableStateOf(existing?.groupType == "MODIFIER") }
    var minSel by remember { mutableStateOf((existing?.minSelect ?: 0).toString()) }
    var maxSel by remember { mutableStateOf((existing?.maxSelect ?: 1).toString()) }
    val mods = remember { mutableStateListOf<ModDraft>() }

    LaunchedEffect(existing?.id) {
        val id = existing?.id ?: return@LaunchedEffect
        mods.clear()
        mods.addAll(loadModifiers(id).map { ModDraft(it.id, it.name, "%.0f".format(it.priceDelta), it.isDefault) })
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        shape = MaterialTheme.shapes.extraLarge,
        title = { Text(if (existing == null) "New group" else "Edit group", style = MaterialTheme.typography.headlineSmall) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(value = name, onValueChange = { name = it }, label = { Text("Group name") }, singleLine = true, shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth())
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Text(if (isModifier) "Modifier (prep note)" else "Add-on (priced extra)", style = MaterialTheme.typography.bodyMedium)
                    Switch(checked = isModifier, onCheckedChange = { isModifier = it })
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(value = minSel, onValueChange = { minSel = it.filter { c -> c.isDigit() } }, label = { Text("Min") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), shape = MaterialTheme.shapes.medium, modifier = Modifier.weight(1f))
                    OutlinedTextField(value = maxSel, onValueChange = { maxSel = it.filter { c -> c.isDigit() } }, label = { Text("Max") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), shape = MaterialTheme.shapes.medium, modifier = Modifier.weight(1f))
                }
                SectionLabelPublic("Options")
                mods.forEachIndexed { i, m ->
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        OutlinedTextField(value = m.name, onValueChange = { mods[i] = m.copy(name = it) }, label = { Text("Name") }, singleLine = true, shape = MaterialTheme.shapes.medium, modifier = Modifier.weight(1.4f))
                        OutlinedTextField(value = m.delta, onValueChange = { mods[i] = m.copy(delta = it.filter { c -> c.isDigit() || c == '.' || c == '-' }) }, label = { Text("± Price") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), shape = MaterialTheme.shapes.medium, modifier = Modifier.weight(1f))
                        IconButton(onClick = { mods.removeAt(i) }) { Icon(Icons.Outlined.Close, "Remove", tint = MaterialTheme.colorScheme.error) }
                    }
                }
                TextButton(onClick = { mods.add(ModDraft(UUID.randomUUID().toString(), "", "0", false)) }) { Text("+ Add option") }
                onDelete?.let { TextButton(onClick = it) { Text("Delete group", color = MaterialTheme.colorScheme.error) } }
            }
        },
        confirmButton = {
            Button(
                enabled = name.isNotBlank(),
                shape = MaterialTheme.shapes.medium,
                onClick = {
                    val id = existing?.id ?: UUID.randomUUID().toString()
                    val group = ModifierGroupEntity(
                        id = id, name = name.trim(),
                        groupType = if (isModifier) "MODIFIER" else "ADD_ON",
                        minSelect = minSel.toIntOrNull() ?: 0, maxSelect = maxSel.toIntOrNull() ?: 1,
                        sortOrder = existing?.sortOrder ?: 0, isActive = true,
                    )
                    val entities = mods.mapIndexedNotNull { i, d ->
                        if (d.name.isBlank()) return@mapIndexedNotNull null
                        ModifierEntity(id = d.id, groupId = id, name = d.name.trim(), kitchenPrintName = null, priceDelta = d.delta.toDoubleOrNull() ?: 0.0, isDefault = d.isDefault, sortOrder = i, isActive = true)
                    }
                    onSave(group, entities)
                },
            ) { Text("Save") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

/** Public section label reused by the group editors (mirrors MenuManager's). */
@Composable
fun SectionLabelPublic(text: String) {
    Text(text, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(top = 4.dp))
}
