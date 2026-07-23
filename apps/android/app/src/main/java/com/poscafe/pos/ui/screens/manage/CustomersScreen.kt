package com.poscafe.pos.ui.screens.manage

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.People
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.poscafe.pos.data.local.dao.CustomerDao
import com.poscafe.pos.data.local.entity.CustomerEntity
import com.poscafe.pos.data.repo.AuthRepository
import com.poscafe.pos.data.repo.CustomerRepository
import com.poscafe.pos.ui.components.EmptyState
import com.poscafe.pos.ui.components.StatusPill
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.util.UUID
import javax.inject.Inject

@HiltViewModel
class CustomersViewModel @Inject constructor(
    dao: CustomerDao,
    private val repo: CustomerRepository,
    private val auth: AuthRepository,
) : ViewModel() {
    val customers: StateFlow<List<CustomerEntity>> =
        dao.all().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    fun save(existing: CustomerEntity?, name: String, phone: String?, email: String?, note: String?, loyaltyPoints: Int) {
        viewModelScope.launch {
            repo.save(
                CustomerEntity(
                    id = existing?.id ?: UUID.randomUUID().toString(),
                    name = name.trim(),
                    phone = phone?.trim()?.takeIf { it.isNotBlank() },
                    email = email?.trim()?.takeIf { it.isNotBlank() },
                    note = note?.trim()?.takeIf { it.isNotBlank() },
                    loyaltyPoints = loyaltyPoints,
                    createdAt = existing?.createdAt ?: System.currentTimeMillis(),
                ),
                auth.current?.userId,
            )
        }
    }

    fun delete(id: String) = viewModelScope.launch { repo.delete(id, auth.current?.userId) }
}

/** Local customer book + simple on-device loyalty points. */
@Composable
fun CustomersScreen(onBack: () -> Unit, vm: CustomersViewModel = hiltViewModel()) {
    val customers by vm.customers.collectAsStateWithLifecycle()
    var editing by remember { mutableStateOf<CustomerEntity?>(null) }
    var adding by remember { mutableStateOf(false) }

    ManageScaffold(
        title = "Customers",
        onBack = onBack,
        fabLabel = "New customer",
        onFab = { adding = true },
    ) { _ ->
        if (customers.isEmpty()) {
            EmptyState(
                icon = Icons.Outlined.People,
                title = "No customers yet",
                subtitle = "Keep a local book of regulars and their loyalty points.",
                modifier = Modifier.fillMaxSize(),
            )
        } else {
            LazyColumn(
                verticalArrangement = Arrangement.spacedBy(8.dp),
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 88.dp),
            ) {
                items(customers, key = { it.id }) { c ->
                    Surface(
                        onClick = { editing = c },
                        shape = MaterialTheme.shapes.large,
                        color = MaterialTheme.colorScheme.surface,
                        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Row(
                            Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            Box(
                                Modifier.size(40.dp).background(MaterialTheme.colorScheme.primaryContainer, CircleShape),
                                contentAlignment = Alignment.Center,
                            ) {
                                Text(
                                    c.name.take(1).uppercase(),
                                    style = MaterialTheme.typography.titleSmall,
                                    color = MaterialTheme.colorScheme.onPrimaryContainer,
                                )
                            }
                            Column(Modifier.weight(1f)) {
                                Text(c.name, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text(
                                    listOfNotNull(c.phone, c.email).joinToString(" · ").ifBlank { "—" },
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                            if (c.loyaltyPoints > 0) {
                                StatusPill(
                                    "${c.loyaltyPoints} pts",
                                    color = MaterialTheme.colorScheme.onPrimaryContainer,
                                    container = MaterialTheme.colorScheme.primaryContainer,
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    if (adding || editing != null) {
        CustomerEditorDialog(
            existing = editing,
            onSave = { name, phone, email, note, pts ->
                vm.save(editing, name, phone, email, note, pts)
                adding = false; editing = null
            },
            onDelete = editing?.let { c -> { vm.delete(c.id); editing = null } },
            onDismiss = { adding = false; editing = null },
        )
    }
}

@Composable
private fun CustomerEditorDialog(
    existing: CustomerEntity?,
    onSave: (name: String, phone: String?, email: String?, note: String?, loyaltyPoints: Int) -> Unit,
    onDelete: (() -> Unit)?,
    onDismiss: () -> Unit,
) {
    var name by remember { mutableStateOf(existing?.name ?: "") }
    var phone by remember { mutableStateOf(existing?.phone ?: "") }
    var email by remember { mutableStateOf(existing?.email ?: "") }
    var note by remember { mutableStateOf(existing?.note ?: "") }
    var points by remember { mutableStateOf(existing?.loyaltyPoints ?: 0) }

    AlertDialog(
        onDismissRequest = onDismiss,
        shape = MaterialTheme.shapes.extraLarge,
        title = { Text(if (existing == null) "New customer" else "Edit customer", style = MaterialTheme.typography.headlineSmall) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(
                    value = name, onValueChange = { name = it },
                    label = { Text("Name") }, singleLine = true,
                    shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = phone, onValueChange = { phone = it },
                    label = { Text("Phone") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                    shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = email, onValueChange = { email = it },
                    label = { Text("Email") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
                    shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = note, onValueChange = { note = it },
                    label = { Text("Note") },
                    shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth(),
                )
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("Loyalty points", style = MaterialTheme.typography.bodyMedium)
                    com.poscafe.pos.ui.components.QuantityStepper(
                        quantity = points,
                        onDecrement = { if (points > 0) points-- },
                        onIncrement = { points++ },
                        buttonSize = 34.dp,
                    )
                }
                onDelete?.let {
                    TextButton(onClick = it) { Text("Delete customer", color = MaterialTheme.colorScheme.error) }
                }
            }
        },
        confirmButton = {
            Button(
                enabled = name.isNotBlank(),
                shape = MaterialTheme.shapes.medium,
                onClick = { onSave(name, phone, email, note, points) },
            ) { Text("Save") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
