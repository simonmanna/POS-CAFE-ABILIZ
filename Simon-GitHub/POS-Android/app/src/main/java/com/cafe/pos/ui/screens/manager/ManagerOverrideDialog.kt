package com.cafe.pos.ui.screens.manager

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cafe.pos.data.model.OverrideVerifyResult
import com.cafe.pos.data.repository.PosRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/** What the cashier is trying to do that needs a manager to authorize. */
enum class OverrideKind(val apiValue: String, val title: String, val description: String) {
    Discount("discount", "Authorize discount",
        "A manager must approve any line discount over 10%."),
    Void("void", "Authorize void",
        "A manager must approve voiding a completed sale."),
    ManualRefund("manual_refund", "Authorize refund",
        "A manager must approve a manual refund."),
}

data class ManagerOverrideUiState(
    val isSubmitting: Boolean = false,
    val error: String? = null,
    val result: OverrideVerifyResult? = null,
)

@HiltViewModel
class ManagerOverrideViewModel @Inject constructor(
    private val posRepository: PosRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(ManagerOverrideUiState())
    val state: StateFlow<ManagerOverrideUiState> = _state.asStateFlow()

    fun verify(
        kind: OverrideKind,
        email: String,
        pin: String?,
        password: String?,
        onSuccess: (OverrideVerifyResult) -> Unit,
    ) {
        if (email.isBlank()) {
            _state.update { it.copy(error = "Enter the manager's email") }
            return
        }
        val credential = pin?.takeIf { it.isNotBlank() } ?: password?.takeIf { it.isNotBlank() }
        if (credential == null) {
            _state.update { it.copy(error = "Enter a PIN or password") }
            return
        }
        viewModelScope.launch {
            _state.update { it.copy(isSubmitting = true, error = null) }
            try {
                val res = posRepository.verifyOverride(
                    email = email.trim(),
                    pin = pin?.takeIf { it.isNotBlank() },
                    password = password?.takeIf { it.isNotBlank() },
                    kind = kind.apiValue,
                )
                _state.update { it.copy(isSubmitting = false, result = res) }
                onSuccess(res)
            } catch (t: Throwable) {
                _state.update { it.copy(isSubmitting = false, error = t.message ?: "Verification failed") }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ManagerOverrideDialog(
    kind: OverrideKind,
    onDismiss: () -> Unit,
    onAuthorized: (managerId: String) -> Unit,
    viewModel: ManagerOverrideViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()
    var tab by remember { mutableIntStateOf(0) }   // 0 = PIN, 1 = password
    var email by remember { mutableStateOf("") }
    var credential by remember { mutableStateOf("") }

    LaunchedEffect(state.result) {
        state.result?.let { onAuthorized(it.managerId) }
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(kind.title) },
        text = {
            Column {
                Text(kind.description, style = MaterialTheme.typography.bodyMedium)
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = email, onValueChange = { email = it },
                    label = { Text("Manager email") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next),
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                TabRow(selectedTabIndex = tab) {
                    Tab(selected = tab == 0, onClick = { tab = 0; credential = "" }, text = { Text("PIN") })
                    Tab(selected = tab == 1, onClick = { tab = 1; credential = "" }, text = { Text("Password") })
                }
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = credential, onValueChange = { credential = it.filter { c -> c.isDigit().or(c.isLetter()) } },
                    label = { Text(if (tab == 0) "PIN" else "Password") },
                    singleLine = true,
                    visualTransformation = if (tab == 0) PasswordVisualTransformation() else PasswordVisualTransformation(),
                    keyboardOptions = if (tab == 0)
                        KeyboardOptions(keyboardType = KeyboardType.NumberPassword, imeAction = ImeAction.Done)
                    else
                        KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
                    modifier = Modifier.fillMaxWidth(),
                )
                state.error?.let {
                    Spacer(Modifier.height(8.dp))
                    Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                }
            }
        },
        confirmButton = {
            Button(
                enabled = !state.isSubmitting,
                onClick = {
                    viewModel.verify(
                        kind = kind,
                        email = email,
                        pin = if (tab == 0) credential else null,
                        password = if (tab == 1) credential else null,
                        onSuccess = { onAuthorized(it.managerId) },
                    )
                },
            ) { Text(if (state.isSubmitting) "Verifying…" else "Authorize") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}