package com.cafe.pos.data.repository

import com.cafe.pos.data.api.ApiErrorMapper
import com.cafe.pos.data.api.CashSessionApi
import com.cafe.pos.data.model.CashRegisterDto
import com.cafe.pos.data.model.CashSessionDto
import com.cafe.pos.data.model.CloseSessionRequest
import com.cafe.pos.data.model.ExpectedCashDto
import com.cafe.pos.data.model.OpenSessionRequest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Cash session / shift repository.
 *
 *  - `activeSession()` is the canonical "is the cashier working?" check.
 *    The terminal refuses to checkout when this returns null.
 *  - `openSession`, `closeSession` call the server's idempotent endpoints
 *    so a network blip during the open/close doesn't double-book a register.
 */
@Singleton
class CashSessionRepository @Inject constructor(
    private val api: CashSessionApi,
) {

    suspend fun activeSession(): CashSessionDto? = withContext(Dispatchers.IO) {
        try { api.openSession() } catch (t: Throwable) { throw ApiErrorMapper.map(t) }
    }

    suspend fun listRegisters(activeOnly: Boolean = true): List<CashRegisterDto> = withContext(Dispatchers.IO) {
        try {
            api.registers(isActive = if (activeOnly) true else null).data
        } catch (t: Throwable) { throw ApiErrorMapper.map(t) }
    }

    suspend fun openSession(registerId: String, openingFloat: Double, notes: String?): CashSessionDto =
        withContext(Dispatchers.IO) {
            try { api.openSession(OpenSessionRequest(registerId, openingFloat, notes)) }
            catch (t: Throwable) { throw ApiErrorMapper.map(t) }
        }

    suspend fun closeSession(closingCounted: Double, notes: String?): CashSessionDto =
        withContext(Dispatchers.IO) {
            try { api.closeSession(CloseSessionRequest(closingCounted, notes)) }
            catch (t: Throwable) { throw ApiErrorMapper.map(t) }
        }

    suspend fun expectedCash(sessionId: String): ExpectedCashDto = withContext(Dispatchers.IO) {
        try { api.expectedCash(sessionId) } catch (t: Throwable) { throw ApiErrorMapper.map(t) }
    }
}