package com.poscafe.pos.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.VerifiedUser
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
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
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

/**
 * Ask a manager for their PIN. The caller verifies it (on-device, against the
 * synced bcrypt hashes) and reports [error]; the PIN also travels with the op
 * so the server re-verifies the approval on replay.
 */
@Composable
fun ApprovalPinDialog(
    title: String,
    message: String,
    error: String?,
    onSubmit: (pin: String) -> Unit,
    onDismiss: () -> Unit,
) {
    var pin by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        shape = MaterialTheme.shapes.extraLarge,
        icon = { Icon(Icons.Outlined.VerifiedUser, null) },
        title = { Text(title, style = MaterialTheme.typography.headlineSmall) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(message, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
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
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            }
        },
        confirmButton = {
            Button(enabled = pin.length >= 4, shape = MaterialTheme.shapes.medium, onClick = { onSubmit(pin) }) { Text("Approve") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

/**
 * View-model side of an approval: run [request]'s action straight away when no
 * manager is needed (self-approval / standalone), otherwise park it until a
 * manager PIN holding [permission] is verified on-device.
 */
class ApprovalGate(
    private val auth: com.poscafe.pos.data.repo.AuthRepository,
    private val permission: String,
    /** The server forbids approving your own work (shift close) — exclude the cashier. */
    private val excludeCurrent: Boolean = false,
) {
    private var pending: (suspend (approverId: String, pin: String?) -> Unit)? = null
    var prompting by mutableStateOf(false); private set
    var error by mutableStateOf<String?>(null); private set

    /**
     * @param selfApproverId when non-null, approve as this user with no PIN.
     * @param needed false → run without any approver (menu items, standalone).
     */
    fun request(
        scope: kotlinx.coroutines.CoroutineScope,
        needed: Boolean,
        selfApproverId: String?,
        action: suspend (approverId: String?, pin: String?) -> Unit,
    ) {
        error = null
        when {
            !needed -> scope.launch { action(null, null) }
            selfApproverId != null -> scope.launch { action(selfApproverId, null) }
            else -> { pending = { id, pin -> action(id, pin) }; prompting = true }
        }
    }

    fun submit(scope: kotlinx.coroutines.CoroutineScope, pin: String) {
        val action = pending ?: return
        scope.launch {
            auth.verifyPinFor(pin, permission, excludeCurrent)
                .onSuccess { mgr ->
                    pending = null; prompting = false; error = null
                    action(mgr.userId, pin)
                }
                .onFailure { error = it.message ?: "PIN rejected" }
        }
    }

    fun cancel() { pending = null; prompting = false; error = null }
}
