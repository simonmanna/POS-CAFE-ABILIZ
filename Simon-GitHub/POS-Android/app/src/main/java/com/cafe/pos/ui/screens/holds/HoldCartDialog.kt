package com.cafe.pos.ui.screens.holds

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/**
 * Dialog for holding the current cart. Asks for a name and optional notes;
 * on confirm the cart is sent to the server via [HoldsViewModel.holdCart]
 * and the local cart is cleared.
 */
@Composable
fun HoldCartDialog(
    lineCount: Int,
    onDismiss: () -> Unit,
    onConfirm: (name: String, notes: String?) -> Unit,
) {
    var name by remember { mutableStateOf("Hold ${System.currentTimeMillis() / 1000 % 10000}") }
    var notes by remember { mutableStateOf("") }
    val canSubmit = name.isNotBlank()

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Hold cart") },
        text = {
            Column {
                Text("$lineCount line(s) will be held for later recall.",
                    style = MaterialTheme.typography.bodyMedium)
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = name, onValueChange = { name = it },
                    label = { Text("Name") }, singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = notes, onValueChange = { notes = it },
                    label = { Text("Notes (optional)") },
                    minLines = 2, maxLines = 4,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        },
        confirmButton = {
            Button(enabled = canSubmit, onClick = { onConfirm(name, notes.ifBlank { null }) }) {
                Text("Hold")
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}