package com.cafe.pos

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.fragment.app.FragmentActivity
import com.cafe.pos.ui.navigation.CafePosNavHost
import com.cafe.pos.ui.security.SessionLockOverlay
import com.cafe.pos.ui.theme.CafePosTheme
import dagger.hilt.android.AndroidEntryPoint

/**
 * Single-activity host. All screens live inside [CafePosNavHost] as Compose destinations.
 *
 * Tablet-first: the activity uses [resizeableActivity] in the manifest so split-screen
 * and freeform windowing on Android tablets render correctly.
 *
 * Extends [FragmentActivity] (instead of plain `ComponentActivity`) because the
 * biometric unlock flow ([androidx.biometric.BiometricPrompt]) needs a `FragmentManager`.
 */
@AndroidEntryPoint
class MainActivity : FragmentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent { App() }
    }

    /**
     * Fired by the platform on every user interaction (touch, key, scroll,
     * etc.) before the event is dispatched. We use it to reset the idle
     * timer in [com.cafe.pos.ui.security.SessionLockController] — if 5
     * minutes elapse without an interaction, the session locks.
     */
    override fun onUserInteraction() {
        super.onUserInteraction()
        com.cafe.pos.ui.security.SessionLockStatic.onUserInteraction()
    }
}

@Composable
private fun App() {
    CafePosTheme {
        Surface(modifier = Modifier.fillMaxSize()) {
            CafePosNavHost()
            SessionLockOverlay()
        }
    }
}