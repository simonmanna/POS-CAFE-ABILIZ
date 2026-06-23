package com.cafe.pos.ui.screens.terminal

import androidx.lifecycle.ViewModel
import com.cafe.pos.hardware.impl.CameraBarcodeScanner
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject

/**
 * Lightweight holder so the [TerminalScreen] can `@hiltViewModel<...>()` the
 * [CameraBarcodeScanner] without making it a screen-level state. The scanner
 * itself is application-scoped (Hilt @Singleton); this VM is just a ViewModel-
 * scoped pointer for Compose navigation safety.
 */
@HiltViewModel
class TerminalScannerHolder @Inject constructor(
    val scanner: CameraBarcodeScanner,
) : ViewModel()