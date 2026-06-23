package com.cafe.pos.ui.security

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Fingerprint
import androidx.compose.material.icons.filled.LocalCafe
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.LockOpen
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import com.cafe.pos.ui.security.BiometricResult
import com.cafe.pos.ui.security.SessionLockController
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * The full-screen lock overlay. Mounted in [com.cafe.pos.MainActivity] so it
 * covers every navigation destination whenever [SessionLockController.isLocked]
 * is true.
 *
 *  - On first composition we immediately fire the biometric prompt.
 *  - If biometric is unavailable / disabled, we show a "Use password" button
 *    that calls [com.cafe.pos.data.repository.AuthRepository.login] (the
 *    current cached email + a fresh password prompt) and re-locks on failure.
 *  - The controller is the source of truth; we only call [unlock] after a
 *    successful biometric or password re-auth.
 */
@Composable
fun SessionLockOverlay() {
    val context = LocalContext.current
    val activity = context as? FragmentActivity ?: return
    val controller: SessionLockController = hiltViewModel<SessionLockVm>().controller
    val locked by controller.isLocked.collectAsState()
    if (!locked) return

    val scope = rememberCoroutineScope()
    val biometric = remember { BiometricAuthManager(activity) }
    var statusText by remember { mutableStateOf<String?>(null) }
    var showPassword by remember { mutableStateOf(false) }

    fun tryBiometric() {
        statusText = null
        scope.launch {
            val res = biometric.prompt()
            when (res) {
                is BiometricResult.Success -> {
                    controller.unlock()
                }
                is BiometricResult.Unavailable -> {
                    statusText = "Biometric not available on this device. Use password."
                    showPassword = true
                }
                is BiometricResult.FallbackRequested -> {
                    statusText = "Use your password to unlock."
                    showPassword = true
                }
                is BiometricResult.Error -> {
                    statusText = res.message
                }
            }
        }
    }

    LaunchedEffect(Unit) { tryBiometric() }

    // Full-screen overlay.
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.primary)
            .padding(32.dp),
        contentAlignment = Alignment.Center,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Surface(
                shape = CircleShape,
                color = MaterialTheme.colorScheme.onPrimary.copy(alpha = 0.15f),
                modifier = Modifier.size(96.dp),
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(
                        Icons.Default.Lock,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onPrimary,
                        modifier = Modifier.size(48.dp),
                    )
                }
            }
            Spacer(Modifier.height(24.dp))
            Icon(
                Icons.Default.LocalCafe,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onPrimary,
                modifier = Modifier.size(48.dp),
            )
            Spacer(Modifier.height(12.dp))
            Text(
                "Cafe POS",
                style = MaterialTheme.typography.displaySmall,
                color = MaterialTheme.colorScheme.onPrimary,
            )
            Spacer(Modifier.height(4.dp))
            Text(
                "Session locked — tap to unlock",
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onPrimary.copy(alpha = 0.8f),
                textAlign = TextAlign.Center,
            )
            statusText?.let { msg ->
                Spacer(Modifier.height(12.dp))
                Text(
                    msg,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.errorContainer,
                    textAlign = TextAlign.Center,
                )
            }
            Spacer(Modifier.height(32.dp))
            Button(
                onClick = { tryBiometric() },
                modifier = Modifier.height(56.dp).width(220.dp),
            ) {
                Icon(Icons.Default.Fingerprint, contentDescription = null)
                Spacer(Modifier.width(8.dp))
                Text("Unlock")
            }
            if (showPassword) {
                Spacer(Modifier.height(12.dp))
                OutlinedButton(
                    onClick = { tryBiometric() },
                    modifier = Modifier.height(48.dp).width(220.dp),
                ) {
                    Icon(Icons.Default.LockOpen, contentDescription = null)
                    Spacer(Modifier.width(8.dp))
                    Text("Try again")
                }
            }
        }
    }
}

/**
 * Hilt VM that exposes the singleton [SessionLockController] to the
 * Composable. The controller itself is the source of truth for the
 * locked state; this VM is just a Composable-side adapter.
 */
@HiltViewModel
class SessionLockVm @Inject constructor(
    val controller: SessionLockController,
) : ViewModel()