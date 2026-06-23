package com.cafe.pos.ui.screens.terminal

import androidx.lifecycle.ViewModel
import com.cafe.pos.data.repository.CashSessionRepository
import com.cafe.pos.domain.session.ShiftSessionStore
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject

/**
 * Hilt VM that exposes the singletons the terminal needs at the Composable
 * scope ([ShiftSessionStore], [CashSessionRepository]). The shift banner and
 * "no open shift" checkout block both consume this — keeping it a real VM
 * means the store is safe to read from Composable side-effects.
 */
@HiltViewModel
class TerminalSessionHolder @Inject constructor(
    val shiftStore: ShiftSessionStore,
    val repository: CashSessionRepository,
) : ViewModel()