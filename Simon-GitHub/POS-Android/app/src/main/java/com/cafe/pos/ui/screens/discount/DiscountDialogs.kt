package com.cafe.pos.ui.screens.discount

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.text.KeyboardOptions
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
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp

/**
 * Dialog for a per-line discount. The cashier types a percent (0–100); the
 * value is committed via the cart store. Manager override (>10%) is the
 * caller's responsibility (the [ManagerOverrideDialog] should be shown first).
 */
@Composable
fun LineDiscountDialog(
    lineName: String,
    currentPercent: Double,
    onDismiss: () -> Unit,
    onConfirm: (percent: Double) -> Unit,
) {
    var percent by remember { mutableStateOf(currentPercent.toInt().toString()) }
    val parsed = percent.toDoubleOrNull()
    val valid = parsed != null && parsed in 0.0..100.0

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Line discount") },
        text = {
            Column {
                Text("Apply a percent discount to \"$lineName\".",
                    style = MaterialTheme.typography.bodyMedium)
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = percent,
                    onValueChange = { percent = it.filter { c -> c.isDigit() || c == '.' } },
                    label = { Text("Percent (0–100)") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal, imeAction = ImeAction.Done),
                    modifier = Modifier.fillMaxWidth(),
                )
                if (parsed != null && parsed > 10.0) {
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "A manager must authorize discounts over 10%.",
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
        },
        confirmButton = {
            Button(enabled = valid, onClick = { parsed?.let { onConfirm(it) } }) { Text("Apply") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

/**
 * Dialog for a transaction-level discount (applied to the subtotal after
 * line discounts). Same rules as [LineDiscountDialog] regarding manager
 * override.
 */
@Composable
fun TransactionDiscountDialog(
    currentPercent: Double,
    onDismiss: () -> Unit,
    onConfirm: (percent: Double) -> Unit,
) {
    var percent by remember { mutableStateOf(currentPercent.toInt().toString()) }
    val parsed = percent.toDoubleOrNull()
    val valid = parsed != null && parsed in 0.0..100.0

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Transaction discount") },
        text = {
            Column {
                Text("Apply a percent discount to the whole sale.",
                    style = MaterialTheme.typography.bodyMedium)
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = percent,
                    onValueChange = { percent = it.filter { c -> c.isDigit() || c == '.' } },
                    label = { Text("Percent (0–100)") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal, imeAction = ImeAction.Done),
                    modifier = Modifier.fillMaxWidth(),
                )
                if (parsed != null && parsed > 10.0) {
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "A manager must authorize discounts over 10%.",
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
        },
        confirmButton = {
            Button(enabled = valid, onClick = { parsed?.let { onConfirm(it) } }) { Text("Apply") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}