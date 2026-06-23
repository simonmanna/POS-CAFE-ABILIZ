package com.cafe.pos.ui.security

import android.content.Context
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

/**
 * Result of a biometric attempt.
 */
sealed class BiometricResult {
    object Success : BiometricResult()
    /** No enrolled fingerprint / face on the device, or hardware unavailable. */
    object Unavailable : BiometricResult()
    /** The user tapped "Use PIN" or the system permanently revoked biometric. */
    object FallbackRequested : BiometricResult()
    /** The user cancelled or hit the back button. */
    data class Error(val code: Int, val message: String) : BiometricResult()
}

/**
 * Wrapper around AndroidX [BiometricPrompt]. The composable layer
 * ([SessionLockOverlay]) owns the [FragmentActivity] reference, which
 * [BiometricPrompt] needs to attach its dialog.
 *
 * Allows BIOMETRIC_STRONG | DEVICE_CREDENTIAL so the user always has
 * a PIN fallback even if the fingerprint reader fails.
 */
class BiometricAuthManager(private val activity: FragmentActivity) {

    fun isAvailable(context: Context): Boolean {
        val mgr = BiometricManager.from(context)
        val result = mgr.canAuthenticate(
            Authenticators.BIOMETRIC_STRONG or Authenticators.DEVICE_CREDENTIAL
        )
        return result == BiometricManager.BIOMETRIC_SUCCESS
    }

    /**
     * Show the system biometric prompt. Suspends until the user
     * authenticates, cancels, or the system reports an error.
     *
     * The continuation is resumed on the main thread.
     */
    suspend fun prompt(
        title: String = "Unlock Cafe POS",
        subtitle: String = "Authenticate to continue",
    ): BiometricResult = suspendCancellableCoroutine { cont ->
        val executor = ContextCompat.getMainExecutor(activity)
        val prompt = BiometricPrompt(
            activity,
            executor,
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    if (cont.isActive) cont.resume(BiometricResult.Success)
                }
                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    if (!cont.isActive) return
                    val r: BiometricResult = when (errorCode) {
                        BiometricPrompt.ERROR_NEGATIVE_BUTTON,
                        BiometricPrompt.ERROR_USER_CANCELED -> BiometricResult.FallbackRequested
                        BiometricPrompt.ERROR_NO_DEVICE_CREDENTIAL,
                        BiometricPrompt.ERROR_NO_BIOMETRICS,
                        BiometricPrompt.ERROR_HW_NOT_PRESENT,
                        BiometricPrompt.ERROR_HW_UNAVAILABLE -> BiometricResult.Unavailable
                        else -> BiometricResult.Error(errorCode, errString.toString())
                    }
                    cont.resume(r)
                }
                override fun onAuthenticationFailed() {
                    // Don't resume — the system shows its own "try again" UI.
                    // The callback above fires when the user finally cancels
                    // or succeeds.
                }
            }
        )
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(title)
            .setSubtitle(subtitle)
            .setAllowedAuthenticators(
                Authenticators.BIOMETRIC_STRONG or Authenticators.DEVICE_CREDENTIAL
            )
            .build()
        prompt.authenticate(info)
    }
}