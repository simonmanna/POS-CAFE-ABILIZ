package com.cafe.pos.ui.screens.login

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.launch

@Composable
fun LoginMfaScreen(
    viewModel: LoginViewModel = hiltViewModel(),
    onVerified: () -> Unit,
) {
    val state by viewModel.state.collectAsState()
    var code by remember { mutableStateOf("") }
    var submitting by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(
            modifier = Modifier.widthIn(max = 480.dp).padding(32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text("Two-factor code", style = MaterialTheme.typography.headlineMedium)
            Text(
                "Enter the 6-digit code from your authenticator app",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            OutlinedTextField(
                value = code,
                onValueChange = { if (it.length <= 6 && it.all(Char::isDigit)) code = it },
                label = { Text("Code") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(0.6f),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword, imeAction = ImeAction.Done),
            )

            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }

            Button(
                onClick = {
                    val mfa = state.mfaToken
                    if (mfa == null || code.length != 6) {
                        error = "Enter the 6-digit code"
                        return@Button
                    }
                    submitting = true
                    error = null
                    viewModel.viewModelScope.launch {
                        try {
                            viewModel.verifyMfa(mfa, code)
                            submitting = false
                            onVerified()
                        } catch (t: Throwable) {
                            submitting = false
                            error = t.message ?: "Verification failed"
                        }
                    }
                },
                enabled = !submitting && code.length == 6,
            ) { Text(if (submitting) "Verifying…" else "Verify") }
        }
    }
}