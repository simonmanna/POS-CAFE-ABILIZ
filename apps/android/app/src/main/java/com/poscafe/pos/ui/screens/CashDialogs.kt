package com.poscafe.pos.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.SwapVert
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.poscafe.pos.data.local.entity.LedgerAccountEntity
import com.poscafe.pos.data.local.entity.PaymentMethodEntity
import com.poscafe.pos.data.repo.CashSessionRepository
import com.poscafe.pos.ui.components.KVRow
import com.poscafe.pos.ui.components.Money
import kotlin.math.abs

/**
 * Shift dialogs shared by the terminal and the More screen. Each offers only
 * the choices the server's shift rules accept (see CashSessionRepository) and
 * stays open showing [error] until the action succeeds.
 */

private fun String.money() = filter { c -> c.isDigit() || c == '.' }

@Composable
private fun Choice(label: String, selected: Boolean, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        shape = MaterialTheme.shapes.small,
        color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surface,
        border = if (selected) null else BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
    ) {
        Text(
            label,
            style = MaterialTheme.typography.labelMedium,
            color = if (selected) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
        )
    }
}

@Composable
private fun AccountPicker(label: String, accounts: List<LedgerAccountEntity>, selected: String?, onPick: (String) -> Unit) {
    Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    if (accounts.isEmpty()) {
        Text(
            "No eligible accounts on this device yet — sync with the server first.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.error,
        )
    } else {
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            accounts.forEach { a -> Choice(a.name, selected == a.id) { onPick(a.id) } }
        }
    }
}

// ------------------------------------------------------------------ open shift

@Composable
fun OpenSessionDialog(
    options: CashSessionRepository.OpeningOptions?,
    error: String?,
    onOpen: (registerId: String, float: Double, sourceAccountId: String?, notes: String?) -> Unit,
    onDismiss: () -> Unit,
) {
    val registers = options?.registers.orEmpty()
    var registerId by remember(registers) { mutableStateOf(registers.firstOrNull()?.id) }
    val ledger = registerId?.let { options?.drawerBalance?.get(it) }
    var float by remember(registerId) { mutableStateOf(ledger?.let { "%.0f".format(it) } ?: "0") }
    var sourceId by remember { mutableStateOf<String?>(null) }
    var notes by remember { mutableStateOf("") }
    val floatValue = float.toDoubleOrNull()
    val added = if (ledger != null && floatValue != null) floatValue - ledger else 0.0

    AlertDialog(
        onDismissRequest = onDismiss,
        shape = MaterialTheme.shapes.extraLarge,
        title = { Text("Open cash session", style = MaterialTheme.typography.headlineSmall) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (registers.isEmpty()) {
                    Text("No cash registers synced to this device yet — pull from the server first.", style = MaterialTheme.typography.bodyMedium)
                } else {
                    Text("Register", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    registers.forEach { r ->
                        Surface(
                            onClick = { registerId = r.id },
                            shape = MaterialTheme.shapes.medium,
                            color = if (registerId == r.id) MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.45f) else MaterialTheme.colorScheme.surface,
                            border = BorderStroke(1.dp, if (registerId == r.id) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline),
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text("${r.code}${r.name?.let { " — $it" } ?: ""}", style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(12.dp))
                        }
                    }
                    ledger?.let { KVRow("Drawer holds (recorded)", Money.format(it)) }
                    OutlinedTextField(
                        value = float,
                        onValueChange = { float = it.money() },
                        label = { Text("Counted opening float") },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        shape = MaterialTheme.shapes.medium,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    if (added < -0.005) {
                        Text(
                            "The count is below what the drawer should hold. Record the removal in the back office before opening.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.error,
                        )
                    }
                    if (added > 0.005) {
                        Text(
                            "${Money.format(added)} is being added to the drawer — where did it come from?",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        AccountPicker("Funding account", options?.floatSources.orEmpty(), sourceId) { sourceId = it }
                        OutlinedTextField(
                            value = notes,
                            onValueChange = { notes = it },
                            label = { Text("Reason") },
                            shape = MaterialTheme.shapes.medium,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            }
        },
        confirmButton = {
            Button(
                enabled = registerId != null && floatValue != null && added >= -0.005 &&
                    (added <= 0.005 || (sourceId != null && notes.isNotBlank())),
                shape = MaterialTheme.shapes.medium,
                onClick = {
                    registerId?.let { onOpen(it, floatValue ?: 0.0, sourceId.takeIf { added > 0.005 }, notes.takeIf { it.isNotBlank() }) }
                },
            ) { Text("Open session") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

// ---------------------------------------------------------------- cash in / out

@Composable
fun MovementDialog(
    type: String,
    context: CashSessionRepository.CashContext?,
    error: String?,
    onSave: (amount: Double, reason: String, counterpartAccountId: String?, managerPin: String?) -> Unit,
    onDismiss: () -> Unit,
) {
    var amount by remember { mutableStateOf("") }
    var reason by remember { mutableStateOf("") }
    var counterpart by remember { mutableStateOf<String?>(null) }
    var pin by remember { mutableStateOf("") }
    val needsManager = type != "pay_in"
    val amountValue = amount.toDoubleOrNull()
    val accounts = if (type == "pay_in") context?.payInAccounts.orEmpty() else context?.payOutAccounts.orEmpty()
    val needsAccount = context?.synced == true

    AlertDialog(
        onDismissRequest = onDismiss,
        shape = MaterialTheme.shapes.extraLarge,
        icon = { Icon(Icons.Outlined.SwapVert, null) },
        title = { Text(if (type == "pay_in") "Cash in" else "Cash out", style = MaterialTheme.typography.headlineSmall) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(
                    value = amount,
                    onValueChange = { amount = it.money() },
                    label = { Text("Amount") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    shape = MaterialTheme.shapes.medium,
                    modifier = Modifier.fillMaxWidth(),
                )
                if (needsAccount) {
                    AccountPicker(if (type == "pay_in") "Came from" else "Went to", accounts, counterpart) { counterpart = it }
                }
                OutlinedTextField(
                    value = reason,
                    onValueChange = { reason = it },
                    label = { Text("Reason") },
                    shape = MaterialTheme.shapes.medium,
                    modifier = Modifier.fillMaxWidth(),
                )
                if (needsManager) ManagerPinField(pin) { pin = it }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            }
        },
        confirmButton = {
            Button(
                enabled = amountValue != null && amountValue > 0 && reason.isNotBlank() &&
                    (!needsAccount || counterpart != null) && (!needsManager || pin.length >= 4),
                shape = MaterialTheme.shapes.medium,
                onClick = { onSave(amountValue ?: 0.0, reason, counterpart, pin.takeIf { needsManager }) },
            ) { Text("Record") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

/** Manager PIN entry for an approval that must come from someone other than the cashier. */
@Composable
fun ManagerPinField(pin: String, onChange: (String) -> Unit) {
    Text(
        "A manager (not you) must approve cash leaving the drawer.",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    OutlinedTextField(
        value = pin,
        onValueChange = { onChange(it.filter { c -> c.isDigit() }.take(8)) },
        label = { Text("Manager PIN") },
        singleLine = true,
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
        shape = MaterialTheme.shapes.medium,
        modifier = Modifier.fillMaxWidth(),
    )
}

// ------------------------------------------------------------------ close shift

/** What the close dialog collected. [managerPin] is set only when approval is needed. */
data class CloseRequest(
    val counted: Double,
    val varianceReason: String?,
    val closingAccounts: Map<String, Double>,
    val uncountedAccounts: Map<String, String>,
    val managerPin: String?,
)

@Composable
fun CloseSessionDialog(
    x: CashSessionRepository.LocalXReport?,
    trackedTenders: List<PaymentMethodEntity>,
    blocker: String?,
    error: String?,
    onClose: (CloseRequest) -> Unit,
    onDismiss: () -> Unit,
) {
    var counted by remember { mutableStateOf("") }
    var reason by remember { mutableStateOf("") }
    var pin by remember { mutableStateOf("") }
    val walletCounts = remember { mutableStateMapOf<String, String>() }
    val notCounted = remember { mutableStateMapOf<String, String>() }
    val countedValue = counted.toDoubleOrNull()
    val variance = if (countedValue != null && x != null) countedValue - x.expectedCash else null

    val tendersDone = trackedTenders.all { t ->
        val acc = t.accountId!!
        if (acc in notCounted) notCounted[acc]!!.isNotBlank() else walletCounts[acc]?.toDoubleOrNull() != null
    }
    val walletDiff = trackedTenders.any { t ->
        val acc = t.accountId!!
        acc !in notCounted && walletCounts[acc]?.toDoubleOrNull()?.let { abs(it - (x?.expectedByAccount?.get(acc) ?: 0.0)) > 0.005 } == true
    }
    val hasVariance = (variance != null && abs(variance) > 0.005) || walletDiff
    val needsManager = notCounted.isNotEmpty() || walletDiff ||
        (variance != null && abs(variance) >= CashSessionRepository.LARGE_VARIANCE)
    val ready = blocker == null && countedValue != null && tendersDone &&
        (!hasVariance || reason.isNotBlank()) && (!needsManager || pin.length >= 4)

    AlertDialog(
        onDismissRequest = onDismiss,
        shape = MaterialTheme.shapes.extraLarge,
        title = { Text("Close session", style = MaterialTheme.typography.headlineSmall) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                blocker?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
                x?.let { KVRow("Expected cash", Money.format(it.expectedCash)) }
                OutlinedTextField(
                    value = counted,
                    onValueChange = { counted = it.money() },
                    label = { Text("Counted cash") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    shape = MaterialTheme.shapes.medium,
                    modifier = Modifier.fillMaxWidth(),
                )
                variance?.let {
                    KVRow(
                        "Variance",
                        Money.format(it),
                        valueColor = if (abs(it) <= 0.005) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
                    )
                }
                // Every shift-tracked wallet (card, mobile money, bank) is counted
                // against its provider balance, or explicitly skipped with a reason.
                trackedTenders.forEach { t ->
                    val acc = t.accountId!!
                    val skipped = acc in notCounted
                    HorizontalDivider()
                    Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(t.label, style = MaterialTheme.typography.titleSmall)
                            Text(
                                "Expected ${Money.format(x?.expectedByAccount?.get(acc) ?: 0.0)}",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        Choice(if (skipped) "Not counted" else "Count", skipped) {
                            if (skipped) notCounted.remove(acc) else notCounted[acc] = ""
                        }
                    }
                    if (skipped) {
                        OutlinedTextField(
                            value = notCounted[acc] ?: "",
                            onValueChange = { notCounted[acc] = it },
                            label = { Text("Why not counted") },
                            shape = MaterialTheme.shapes.medium,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    } else {
                        OutlinedTextField(
                            value = walletCounts[acc] ?: "",
                            onValueChange = { walletCounts[acc] = it.money() },
                            label = { Text("Provider balance for this shift") },
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                            shape = MaterialTheme.shapes.medium,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
                if (hasVariance) {
                    OutlinedTextField(
                        value = reason,
                        onValueChange = { reason = it },
                        label = { Text("Reason for the difference") },
                        shape = MaterialTheme.shapes.medium,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                if (needsManager) {
                    Text(
                        "A manager (not you) must approve this close.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    OutlinedTextField(
                        value = pin,
                        onValueChange = { pin = it.filter { c -> c.isDigit() }.take(8) },
                        label = { Text("Manager PIN") },
                        singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                        shape = MaterialTheme.shapes.medium,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            }
        },
        confirmButton = {
            Button(
                enabled = ready,
                shape = MaterialTheme.shapes.medium,
                onClick = {
                    onClose(
                        CloseRequest(
                            counted = countedValue ?: 0.0,
                            varianceReason = reason.takeIf { it.isNotBlank() },
                            closingAccounts = trackedTenders.mapNotNull { t ->
                                val acc = t.accountId!!
                                if (acc in notCounted) null else walletCounts[acc]?.toDoubleOrNull()?.let { acc to it }
                            }.toMap(),
                            uncountedAccounts = notCounted.toMap(),
                            managerPin = pin.takeIf { needsManager },
                        ),
                    )
                },
            ) { Text("Close session") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
