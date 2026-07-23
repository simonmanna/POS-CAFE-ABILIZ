package com.poscafe.pos.ui.screens

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.poscafe.pos.data.local.entity.CustomerEntity

@Composable
fun CustomerPickerDialog(
    customers: List<CustomerEntity>,
    selectedId: String?,
    onSelect: (CustomerEntity) -> Unit,
    onCreateCustomer: (String, String?) -> Unit,
    onDismiss: () -> Unit,
) {
    var searchQuery by remember { mutableStateOf("") }
    var showCreateForm by remember { mutableStateOf(false) }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(
            shape = MaterialTheme.shapes.extraLarge,
            color = MaterialTheme.colorScheme.surface,
            modifier = Modifier.fillMaxWidth().fillMaxHeight(0.85f).padding(16.dp),
        ) {
            Column(Modifier.fillMaxSize().padding(20.dp)) {
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("Select customer", style = MaterialTheme.typography.headlineSmall)
                    IconButton(onClick = onDismiss) { Icon(Icons.Filled.Close, "Close") }
                }
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = searchQuery,
                    onValueChange = { searchQuery = it },
                    placeholder = { Text("Search by name or phone…") },
                    leadingIcon = { Icon(Icons.Filled.Search, null, modifier = Modifier.size(20.dp)) },
                    singleLine = true,
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.fillMaxWidth().height(52.dp),
                )
                Spacer(Modifier.height(12.dp))

                val filtered = remember(customers, searchQuery) {
                    if (searchQuery.isBlank()) customers
                    else customers.filter { c ->
                        c.name.contains(searchQuery, ignoreCase = true) ||
                            c.phone?.contains(searchQuery) == true
                    }
                }

                if (filtered.isEmpty()) {
                    Box(Modifier.weight(1f), contentAlignment = Alignment.Center) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Text("No customers found", style = MaterialTheme.typography.bodyLarge)
                            Spacer(Modifier.height(8.dp))
                            Text(
                                if (searchQuery.isNotBlank()) "Try a different search" else "Add a new customer to get started",
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                } else {
                    LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        items(filtered, key = { it.id }) { customer ->
                            CustomerRow(
                                customer = customer,
                                selected = customer.id == selectedId,
                                onClick = { onSelect(customer) },
                            )
                        }
                    }
                }

                Spacer(Modifier.height(12.dp))
                if (showCreateForm) {
                    CreateCustomerForm(
                        onSave = { name, phone -> onCreateCustomer(name, phone); showCreateForm = false },
                        onCancel = { showCreateForm = false },
                    )
                } else {
                    OutlinedButton(
                        onClick = { showCreateForm = true },
                        shape = RoundedCornerShape(12.dp),
                        modifier = Modifier.fillMaxWidth().height(48.dp),
                    ) {
                        Icon(Icons.Filled.Add, null, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(8.dp))
                        Text("New customer")
                    }
                }
            }
        }
    }
}

@Composable
private fun CustomerRow(customer: CustomerEntity, selected: Boolean, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        shape = MaterialTheme.shapes.medium,
        color = if (selected) MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.45f) else MaterialTheme.colorScheme.surface,
        border = if (selected) {
            androidx.compose.foundation.BorderStroke(1.5.dp, MaterialTheme.colorScheme.primary)
        } else null,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            Modifier.padding(14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Icon(
                Icons.Filled.Person, null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(24.dp),
            )
            Column(Modifier.weight(1f)) {
                Text(customer.name, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
                customer.phone?.let {
                    Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (customer.loyaltyPoints > 0) {
                    Text(
                        "${customer.loyaltyPoints} pts",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.primary,
                    )
                }
            }
            if (selected) {
                Text("Selected", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
            }
        }
    }
}

@Composable
private fun CreateCustomerForm(onSave: (String, String?) -> Unit, onCancel: () -> Unit) {
    var name by remember { mutableStateOf("") }
    var phone by remember { mutableStateOf("") }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(
            value = name,
            onValueChange = { name = it },
            label = { Text("Customer name") },
            singleLine = true,
            shape = RoundedCornerShape(12.dp),
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = phone,
            onValueChange = { phone = it },
            label = { Text("Phone (optional)") },
            singleLine = true,
            shape = RoundedCornerShape(12.dp),
            modifier = Modifier.fillMaxWidth(),
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = onCancel, shape = RoundedCornerShape(12.dp), modifier = Modifier.weight(1f)) {
                Text("Cancel")
            }
            Button(
                onClick = { if (name.isNotBlank()) onSave(name.trim(), phone.trim().takeIf { it.isNotBlank() }) },
                enabled = name.isNotBlank(),
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier.weight(1f),
            ) {
                Text("Save")
            }
        }
    }
}
