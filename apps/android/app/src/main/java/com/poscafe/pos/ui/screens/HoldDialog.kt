package com.poscafe.pos.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.DeleteOutline
import androidx.compose.material.icons.filled.Restore
import androidx.compose.material.icons.outlined.HourglassBottom
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.poscafe.pos.data.local.entity.LocalHoldEntity
import com.poscafe.pos.ui.components.Money
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun HoldDialog(
    mode: HoldDialogMode,
    holds: List<LocalHoldEntity>,
    onSave: (String) -> Unit,
    onRetrieve: (LocalHoldEntity) -> Unit,
    onDelete: (LocalHoldEntity) -> Unit,
    onDismiss: () -> Unit,
) {
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(
            shape = MaterialTheme.shapes.extraLarge,
            color = MaterialTheme.colorScheme.surface,
            modifier = Modifier.fillMaxWidth().fillMaxHeight(0.8f).padding(16.dp),
        ) {
            Column(Modifier.fillMaxSize().padding(20.dp)) {
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        if (mode is HoldDialogMode.Save) "Hold order" else "Recall held order",
                        style = MaterialTheme.typography.headlineSmall,
                    )
                    IconButton(onClick = onDismiss) { Icon(Icons.Filled.Close, "Close") }
                }
                Spacer(Modifier.height(16.dp))

                when (mode) {
                    is HoldDialogMode.Save -> SaveHoldContent(onSave = onSave)
                    is HoldDialogMode.Recall -> RecallHoldContent(
                        holds = holds,
                        onRetrieve = onRetrieve,
                        onDelete = onDelete,
                    )
                }
            }
        }
    }
}

sealed interface HoldDialogMode {
    data object Save : HoldDialogMode
    data object Recall : HoldDialogMode
}

@Composable
private fun SaveHoldContent(onSave: (String) -> Unit) {
    var name by remember { mutableStateOf("") }

    Column {
        Text(
            "Give this order a name so you can find it later.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(16.dp))
        OutlinedTextField(
            value = name,
            onValueChange = { name = it },
            label = { Text("Order name") },
            placeholder = { Text("E.g. Table 5 — James") },
            singleLine = true,
            shape = RoundedCornerShape(12.dp),
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(24.dp))
        Button(
            onClick = { if (name.isNotBlank()) onSave(name.trim()) },
            enabled = name.isNotBlank(),
            shape = RoundedCornerShape(12.dp),
            modifier = Modifier.fillMaxWidth().height(52.dp),
        ) {
            Text("Save & clear cart")
        }
    }
}

@Composable
private fun RecallHoldContent(
    holds: List<LocalHoldEntity>,
    onRetrieve: (LocalHoldEntity) -> Unit,
    onDelete: (LocalHoldEntity) -> Unit,
) {
    if (holds.isEmpty()) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Icon(
                    Icons.Outlined.HourglassBottom, null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(48.dp),
                )
                Spacer(Modifier.height(12.dp))
                Text("No held orders", style = MaterialTheme.typography.bodyLarge)
                Text(
                    "Hold an order during checkout to retrieve it here.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    } else {
        LazyColumn(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            items(holds, key = { it.id }) { hold ->
                HoldRow(
                    hold = hold,
                    onRetrieve = { onRetrieve(hold) },
                    onDelete = { onDelete(hold) },
                )
            }
        }
    }
}

@Composable
private fun HoldRow(hold: LocalHoldEntity, onRetrieve: () -> Unit, onDelete: () -> Unit) {
    Surface(
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            Modifier.padding(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(hold.name, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(
                        Money.format(hold.totalAmount),
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.primary,
                    )
                    Text(
                        SimpleDateFormat("d MMM HH:mm", Locale.getDefault()).format(Date(hold.createdAt)),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            IconButton(onClick = onRetrieve, modifier = Modifier.size(36.dp)) {
                Icon(Icons.Filled.Restore, "Retrieve", tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(20.dp))
            }
            IconButton(onClick = onDelete, modifier = Modifier.size(36.dp)) {
                Icon(Icons.Filled.DeleteOutline, "Delete", tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(20.dp))
            }
        }
    }
}
