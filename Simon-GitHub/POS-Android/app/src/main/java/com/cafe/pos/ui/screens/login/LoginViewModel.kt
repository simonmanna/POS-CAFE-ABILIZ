package com.cafe.pos.ui.screens.login

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cafe.pos.data.repository.AuthRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class LoginUiState(
    val orgCode: String = "",
    val email: String = "",
    val password: String = "",
    val serverUrl: String = "http://10.0.2.2:3000/",
    val isSubmitting: Boolean = false,
    val error: String? = null,
    val requiresMfa: Boolean = false,
    val mfaToken: String? = null,
)

@HiltViewModel
class LoginViewModel @Inject constructor(
    private val authRepository: AuthRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(LoginUiState())
    val state: StateFlow<LoginUiState> = _state.asStateFlow()

    fun onOrgCode(v: String) = _state.update { it.copy(orgCode = v) }
    fun onEmail(v: String) = _state.update { it.copy(email = v) }
    fun onPassword(v: String) = _state.update { it.copy(password = v) }
    fun onServerUrl(v: String) = _state.update { it.copy(serverUrl = v) }
    fun clearError() = _state.update { it.copy(error = null) }

    suspend fun verifyMfa(mfaToken: String, code: String) {
        viewModelScope.launch {
            _state.update { it.copy(isSubmitting = true, error = null) }
            try {
                authRepository.verifyMfa(mfaToken, code)
                _state.update { it.copy(isSubmitting = false) }
            } catch (t: Throwable) {
                _state.update { it.copy(isSubmitting = false, error = t.message ?: "Verification failed") }
            }
        }
    }

    fun submit(onLoggedIn: () -> Unit, onMfaRequired: () -> Unit) {
        val s = _state.value
        if (s.orgCode.isBlank() || s.email.isBlank() || s.password.isBlank()) {
            _state.update { it.copy(error = "Please fill in all fields") }
            return
        }
        viewModelScope.launch {
            _state.update { it.copy(isSubmitting = true, error = null) }
            try {
                val res = authRepository.login(s.orgCode.trim(), s.email.trim(), s.password)
                if (res.requiresMfa && res.mfaToken != null) {
                    _state.update {
                        it.copy(isSubmitting = false, requiresMfa = true, mfaToken = res.mfaToken)
                    }
                    onMfaRequired()
                } else {
                    _state.update { it.copy(isSubmitting = false) }
                    onLoggedIn()
                }
            } catch (t: Throwable) {
                _state.update { it.copy(isSubmitting = false, error = t.message ?: "Login failed") }
            }
        }
    }
}