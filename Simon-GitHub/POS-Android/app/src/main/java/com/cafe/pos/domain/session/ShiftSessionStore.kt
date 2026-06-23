package com.cafe.pos.domain.session

import com.cafe.pos.data.model.CashSessionDto
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Process-wide cache of the currently-open cash session. Populated by the
 * terminal on first render and on every shift open/close. The terminal refuses
 * to checkout when [current] is null.
 *
 * Why a singleton and not a ViewModel: the session is conceptually shared
 * between the terminal, the reports screen (X/Z look up by id), and the
 * shift-close dialog. A ViewModel would force a navigation-level coupling.
 */
@Singleton
class ShiftSessionStore @Inject constructor() {

    private val _current = MutableStateFlow<CashSessionDto?>(null)
    val current: StateFlow<CashSessionDto?> = _current.asStateFlow()

    fun set(session: CashSessionDto?) {
        _current.value = session
    }

    fun clear() {
        _current.value = null
    }

    fun sessionId(): String? = _current.value?.id
}