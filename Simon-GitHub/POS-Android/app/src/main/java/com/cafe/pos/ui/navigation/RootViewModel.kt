package com.cafe.pos.ui.navigation

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cafe.pos.data.repository.AuthRepository
import com.cafe.pos.data.session.ShiftSessionBootstrap
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * Holds the auth state at the activity root so the [CafePosNavHost] can decide
 * whether to show the login flow or the terminal.
 */
@HiltViewModel
class RootViewModel @Inject constructor(
    private val authRepository: AuthRepository,
    private val shiftSessionBootstrap: ShiftSessionBootstrap,
) : ViewModel() {

    val accessToken: StateFlow<String?> = authRepository.accessTokenFlow
        .stateIn(viewModelScope, SharingStarted.Eagerly, null)

    fun logout() {
        viewModelScope.launch { authRepository.logout() }
    }

    /** Re-fetch the currently-open cash session for the logged-in user. */
    fun refreshShiftSession() {
        shiftSessionBootstrap.refresh()
    }
}