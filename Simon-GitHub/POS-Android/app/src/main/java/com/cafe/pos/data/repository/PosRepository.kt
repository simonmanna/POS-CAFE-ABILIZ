package com.cafe.pos.data.repository

import com.cafe.pos.data.api.ApiErrorMapper
import com.cafe.pos.data.api.PosApi
import com.cafe.pos.data.local.CafePosDatabase
import com.cafe.pos.data.local.PendingSaleEntity
import com.cafe.pos.data.model.CheckoutLineDto
import com.cafe.pos.data.model.CheckoutRequest
import com.cafe.pos.data.model.CheckoutResult
import com.cafe.pos.data.model.CreateHoldRequest
import com.cafe.pos.data.model.HourlyReport
import com.cafe.pos.data.model.KdsTicketDto
import com.cafe.pos.data.model.KdsTransitionRequest
import com.cafe.pos.data.model.LoyaltyBalanceDto
import com.cafe.pos.data.model.LoyaltyEarnRequest
import com.cafe.pos.data.model.LoyaltyRedeemRequest
import com.cafe.pos.data.model.OverrideVerifyRequest
import com.cafe.pos.data.model.OverrideVerifyResult
import com.cafe.pos.data.model.PosHoldDto
import com.cafe.pos.data.model.RefundRequest
import com.cafe.pos.data.model.TopItemRow
import com.cafe.pos.data.model.UpdateHoldNotesRequest
import com.cafe.pos.data.model.XReport
import kotlinx.coroutines.flow.Flow
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton

/**
 * POS repository: checkout / refund / void / holds / reports / loyalty / KDS.
 *
 * Checkout is special — when offline we enqueue the request in Room and return
 * a synthetic pending [CheckoutResult]; [flushPendingSales] drains the queue when
 * the network returns.
 */
@Singleton
class PosRepository @Inject constructor(
    private val api: PosApi,
    private val db: CafePosDatabase,
) {

    /* ----- Checkout ----- */

    suspend fun checkout(
        lines: List<CheckoutLineDto>,
        paymentMethod: String? = null,
        amountTendered: Double? = null,
        transactionDiscountPercent: Double = 0.0,
        overrideById: String? = null,
        partnerId: String? = null,
        cashSessionId: String? = null,
        branchId: String? = null,
        notes: String? = null,
    ): CheckoutResult {
        val idempotencyKey = UUID.randomUUID().toString()
        val req = CheckoutRequest(
            partnerId = partnerId,
            lines = lines,
            transactionDiscountPercent = transactionDiscountPercent,
            overrideById = overrideById,
            tenders = null,
            paymentMethod = paymentMethod,
            amountTendered = amountTendered,
            cashSessionId = cashSessionId,
            branchId = branchId,
            notes = notes,
        )
        return try {
            api.checkout(idempotencyKey, req)
        } catch (t: Throwable) {
            val ex = ApiErrorMapper.map(t)
            if (ex.statusCode == null) {
                // Offline / network — queue.
                enqueuePending(idempotencyKey, req, cashSessionId)
                CheckoutResult(
                    invoiceId = "PENDING-${idempotencyKey.take(8)}",
                    invoiceNumber = "PENDING-${idempotencyKey.take(8).uppercase()}",
                    paymentIds = emptyList(),
                    total = req.lines.sumOf { it.quantity * it.unitPrice * (1 - it.discountPercent / 100.0) },
                    change = 0.0,
                )
            } else throw ex
        }
    }

    /**
     * Drain queued sales whose `nextAttemptAt` is due. Failed rows are
     * rescheduled with exponential backoff ([SyncBackoff]); rows that hit
     * the attempt cap are skipped but left in the queue so the cashier
     * can see them in the sync banner and act.
     *
     * Returns the number of sales successfully sent to the server.
     */
    suspend fun flushPendingSales(): Int {
        val dao = db.pendingSaleDao()
        val now = System.currentTimeMillis()
        val due = dao.dueForRetry(now)
        if (due.isEmpty()) return 0
        var flushed = 0
        for (row in due) {
            if (com.cafe.pos.data.sync.SyncBackoff.isDead(row.attempts)) {
                // Dead — don't retry; UI surfaces a manual-recovery banner.
                continue
            }
            try {
                val req = CafePosDatabase.moshi.adapter(CheckoutRequest::class.java).fromJson(row.payload)
                    ?: continue
                api.checkout(row.idempotencyKey, req)
                dao.delete(row.id)
                flushed++
            } catch (t: Throwable) {
                val newAttempts = row.attempts + 1
                val nextAt = com.cafe.pos.data.sync.SyncBackoff.nextAttemptAt(newAttempts, now)
                dao.recordFailure(
                    id = row.id,
                    err = t.message ?: t.javaClass.simpleName,
                    now = now,
                    nextAt = nextAt,
                )
            }
        }
        return flushed
    }

    /**
     * Enqueue a checkout that was captured while offline. The next
     * [flushPendingSales] (or [SyncWorker] run) will replay it with the
     * same `Idempotency-Key`, so the server dedupes if the original
     * request actually went through.
     */
    private suspend fun enqueuePending(
        idempotencyKey: String,
        req: CheckoutRequest,
        cashSessionId: String?,
    ) {
        val payload = CafePosDatabase.moshi.adapter(CheckoutRequest::class.java).toJson(req)
        db.pendingSaleDao().upsert(
            PendingSaleEntity(
                id = idempotencyKey,
                idempotencyKey = idempotencyKey,
                payload = payload,
                cashSessionId = cashSessionId,
                createdAt = System.currentTimeMillis(),
            )
        )
    }

    val pendingSalesFlow: Flow<List<PendingSaleEntity>> = db.pendingSaleDao().observeAll()

    /* ----- Refund / Void ----- */

    suspend fun refund(invoiceId: String, reason: String?, overrideById: String?, cashSessionId: String?): CheckoutResult =
        try { api.refund(UUID.randomUUID().toString(), RefundRequest(invoiceId, reason, cashSessionId, overrideById)) }
        catch (t: Throwable) { throw ApiErrorMapper.map(t) }

    suspend fun voidSale(invoiceId: String, reason: String, overrideById: String): CheckoutResult =
        try { api.voidSale(UUID.randomUUID().toString(), invoiceId, mapOf("reason" to reason, "overrideById" to overrideById)) }
        catch (t: Throwable) { throw ApiErrorMapper.map(t) }

    /* ----- Holds ----- */

    suspend fun listHolds(status: String = "open"): List<PosHoldDto> =
        try { api.holds(status) } catch (t: Throwable) { throw ApiErrorMapper.map(t) }

    suspend fun createHold(name: String, lines: List<CheckoutLineDto>, notes: String? = null): PosHoldDto =
        try { api.createHold(CreateHoldRequest(name = name, lines = lines, notes = notes)) }
        catch (t: Throwable) { throw ApiErrorMapper.map(t) }

    suspend fun recallHold(id: String): PosHoldDto =
        try { api.recallHold(id) } catch (t: Throwable) { throw ApiErrorMapper.map(t) }

    suspend fun cancelHold(id: String) {
        try { api.cancelHold(id) } catch (t: Throwable) { throw ApiErrorMapper.map(t) }
    }

    suspend fun updateHoldNotes(id: String, notes: String): PosHoldDto =
        try { api.updateHoldNotes(id, UpdateHoldNotesRequest(notes)) }
        catch (t: Throwable) { throw ApiErrorMapper.map(t) }

    /* ----- Manager override ----- */

    suspend fun verifyOverride(email: String, pin: String?, password: String?, kind: String): OverrideVerifyResult =
        try { api.verifyOverride(OverrideVerifyRequest(email, pin, password, kind)) }
        catch (t: Throwable) { throw ApiErrorMapper.map(t) }

    /* ----- Reports ----- */

    suspend fun xReport(cashSessionId: String? = null): XReport =
        try { api.xReport(cashSessionId) } catch (t: Throwable) { throw ApiErrorMapper.map(t) }

    suspend fun zReport(cashSessionId: String? = null): XReport =
        try { api.zReport(cashSessionId) } catch (t: Throwable) { throw ApiErrorMapper.map(t) }

    suspend fun salesByHour(date: String): HourlyReport =
        try { api.salesByHour(date) } catch (t: Throwable) { throw ApiErrorMapper.map(t) }

    suspend fun topItems(fromDate: String, toDate: String, limit: Int = 20): List<TopItemRow> =
        try { api.topItems(fromDate, toDate, limit) } catch (t: Throwable) { throw ApiErrorMapper.map(t) }

    /* ----- KDS ----- */

    suspend fun kdsTickets(status: String? = null): List<KdsTicketDto> =
        try { api.kdsTickets(status) } catch (t: Throwable) { throw ApiErrorMapper.map(t) }

    suspend fun kdsTransition(ticketId: String, status: String): KdsTicketDto =
        try { api.kdsTransition(ticketId, KdsTransitionRequest(status)) }
        catch (t: Throwable) { throw ApiErrorMapper.map(t) }

    /* ----- Loyalty ----- */

    suspend fun loyaltyBalance(partnerId: String): LoyaltyBalanceDto =
        try { api.loyaltyBalance(partnerId) } catch (t: Throwable) { throw ApiErrorMapper.map(t) }

    suspend fun loyaltyEarn(partnerId: String, saleAmount: Double, invoiceId: String?): LoyaltyBalanceDto =
        try { api.loyaltyEarn(LoyaltyEarnRequest(partnerId, saleAmount, invoiceId)) }
        catch (t: Throwable) { throw ApiErrorMapper.map(t) }

    suspend fun loyaltyRedeem(partnerId: String, points: Int, invoiceId: String?): LoyaltyBalanceDto =
        try { api.loyaltyRedeem(LoyaltyRedeemRequest(partnerId, points, invoiceId)) }
        catch (t: Throwable) { throw ApiErrorMapper.map(t) }

    /* ----- Modifiers / Combos ----- */

    suspend fun modifierGroups(): List<com.cafe.pos.data.model.ModifierGroupDto> =
        try { api.modifierGroups() } catch (t: Throwable) { throw ApiErrorMapper.map(t) }

    suspend fun combos(): List<com.cafe.pos.data.model.ComboDto> =
        try { api.combos() } catch (t: Throwable) { throw ApiErrorMapper.map(t) }
}