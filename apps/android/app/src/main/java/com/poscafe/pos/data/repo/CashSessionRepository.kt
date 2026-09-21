package com.poscafe.pos.data.repo

import com.poscafe.pos.data.DeviceConfig
import com.poscafe.pos.data.local.dao.CashInventoryDao
import com.poscafe.pos.data.local.dao.CashSessionDao
import com.poscafe.pos.data.local.dao.OpQueueDao
import com.poscafe.pos.data.local.dao.RefundDao
import com.poscafe.pos.data.local.dao.RegisterDao
import com.poscafe.pos.data.local.dao.SaleDao
import com.poscafe.pos.data.local.dao.TabDao
import com.poscafe.pos.data.local.entity.LedgerAccountEntity
import com.poscafe.pos.data.local.entity.LocalCashMovementEntity
import com.poscafe.pos.data.local.entity.LocalCashSessionEntity
import com.poscafe.pos.data.local.entity.LocalSaleEntity
import com.poscafe.pos.data.local.entity.OpQueueEntity
import com.poscafe.pos.data.local.entity.PaymentMethodEntity
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import java.time.Instant
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.math.abs

/**
 * Offline cash sessions. The device runs its OWN register (one CashRegister
 * per device — structurally no cross-device session conflicts). GL posting
 * happens exclusively on the server when the ops replay in order:
 * open → sales → movements → close.
 *
 * Every op is shaped to pass the server's shift rules on replay, pre-checked
 * here against the pulled cash reference data (ledger accounts, tender
 * methods) so a cashier learns about a problem at the till, not from a
 * dead-letter hours later:
 *   - open: the counted float may not be below the drawer ledger; float added
 *     on top of it needs a funding account and a reason;
 *   - movement: a reason and a counterpart account (adjustments: short/over);
 *   - close: every shift-tracked tender counted (or marked not counted with a
 *     reason + manager), a variance explained, open tabs settled, and no
 *     rejected sync ops outstanding.
 */
@Singleton
class CashSessionRepository @Inject constructor(
    private val dao: CashSessionDao,
    private val saleDao: SaleDao,
    private val refundDao: RefundDao,
    private val opQueue: OpQueueDao,
    private val registerDao: RegisterDao,
    private val refs: CashInventoryDao,
    private val tabDao: TabDao,
    private val config: DeviceConfig,
) {
    private val json = Json { ignoreUnknownKeys = true }

    fun openSession(): Flow<LocalCashSessionEntity?> = dao.openFlow()

    /** Recent sessions (open + closed) for the shift history list. */
    fun recentSessions(): Flow<List<LocalCashSessionEntity>> = dao.recent()

    // ---------------------------------------------------------------- context

    /** What the cash dialogs need to offer only server-valid choices. */
    data class CashContext(
        /** The register's drawer account (null until reference data is pulled). */
        val drawer: LedgerAccountEntity?,
        val floatSources: List<LedgerAccountEntity>,
        val payInAccounts: List<LedgerAccountEntity>,
        val payOutAccounts: List<LedgerAccountEntity>,
        val shortOver: LedgerAccountEntity?,
        /** Tender accounts counted at close — one entry per account. */
        val trackedTenders: List<PaymentMethodEntity>,
    ) {
        /** True once the server's cash reference data has reached this device. */
        val synced: Boolean get() = drawer != null
    }

    suspend fun context(cashRegisterId: String?): CashContext {
        val accounts = refs.accounts()
        val registerId = cashRegisterId ?: dao.open()?.cashRegisterId
        val register = registerId?.let { id -> registerDao.all().firstOrNull { it.id == id } }
        val drawer = register?.defaultAccountId?.let { id -> accounts.firstOrNull { it.id == id } }
        return CashContext(
            drawer = drawer,
            floatSources = accounts.filter { it.has("float_source") },
            payInAccounts = accounts.filter { it.has("pay_in") },
            payOutAccounts = accounts.filter { it.has("pay_out") },
            shortOver = accounts.firstOrNull { it.has("cash_short_over") },
            trackedTenders = refs.paymentMethods()
                .filter { it.trackInShift && it.accountId != null }
                .distinctBy { it.accountId },
        )
    }

    // ------------------------------------------------------------------- open

    /** Everything the open-shift dialog shows: registers, drawer ledgers, float sources. */
    data class OpeningOptions(
        val registers: List<com.poscafe.pos.data.local.entity.CashRegisterEntity>,
        /** registerId → drawer ledger balance at last pull (absent = unknown). */
        val drawerBalance: Map<String, Double>,
        val floatSources: List<LedgerAccountEntity>,
    )

    suspend fun openingOptions(): OpeningOptions {
        val accounts = refs.accounts().associateBy { it.id }
        val registers = registerDao.active()
        return OpeningOptions(
            registers = registers,
            drawerBalance = registers.mapNotNull { r ->
                r.defaultAccountId?.let { accounts[it]?.balance }?.let { r.id to it }
            }.toMap(),
            floatSources = accounts.values.filter { it.has("float_source") },
        )
    }

    suspend fun open(
        actorUserId: String,
        cashRegisterId: String,
        openingFloat: Double,
        sourceAccountId: String? = null,
        notes: String? = null,
    ): LocalCashSessionEntity {
        check(dao.open() == null) { "A session is already open on this device" }
        require(openingFloat >= 0) { "The opening float cannot be negative" }
        val ctx = context(cashRegisterId)
        val ledger = ctx.drawer?.balance
        if (ledger != null) {
            val funding = openingFloat - ledger
            check(funding >= -0.005) {
                "The counted float is below the drawer's recorded ${fmt(ledger)}. Record the removal in the back office before opening."
            }
            if (funding > 0.005) {
                val source = sourceAccountId?.let { id -> ctx.floatSources.firstOrNull { it.id == id } }
                require(source != null && !notes.isNullOrBlank()) {
                    "Choose where the extra ${fmt(funding)} came from and give a reason"
                }
                source.balance?.let { bal ->
                    check(bal + 0.005 >= funding) { "${source.name} only has ${fmt(bal)} recorded" }
                }
            }
        }
        val needsSource = ledger != null && openingFloat - ledger > 0.005

        val id = UUID.randomUUID().toString()
        val now = Instant.now()
        val session = LocalCashSessionEntity(
            id = id,
            cashRegisterId = cashRegisterId,
            actorUserId = actorUserId,
            openedAt = now.toEpochMilli(),
            closedAt = null,
            openingFloat = openingFloat,
            closingCounted = null,
            varianceReason = null,
            status = "open",
            syncStatus = "queued",
            serverId = null,
        )
        dao.insert(session)
        enqueue(id, "cash_session.open", actorUserId, now, buildJsonObject {
            put("cashRegisterId", cashRegisterId)
            put("openingFloat", openingFloat)
            put("clientId", id)
            if (needsSource) put("openingSourceAccountId", sourceAccountId)
            notes?.takeIf { it.isNotBlank() }?.let { put("notes", it.trim()) }
        })
        return session
    }

    // --------------------------------------------------------------- movement

    /**
     * Pay-in / pay-out / adjustment on the open drawer. [counterpartAccountId]
     * is where the money came from or went (safe, bank, expense, owner…);
     * adjustments always book to the cash short/over account. Cash leaving the
     * drawer (pay-out, adjustment) needs a manager holding cash_session:cash_out
     * who is not the shift's cashier — their PIN travels with the op.
     */
    suspend fun recordMovement(
        actorUserId: String,
        movementType: String,
        amount: Double,
        reason: String,
        counterpartAccountId: String?,
        approval: Approval? = null,
        opId: String = UUID.randomUUID().toString(),
    ) {
        val session = dao.open() ?: error("No open session")
        require(movementType in setOf("pay_in", "pay_out", "adjustment")) { "Unknown movement type" }
        require(amount != 0.0 && (movementType == "adjustment" || amount > 0)) { "Enter a positive amount" }
        require(reason.isNotBlank()) { "A reason is required for a cash movement" }
        val ctx = context(session.cashRegisterId)
        val counterpart = if (movementType == "adjustment") ctx.shortOver?.id ?: counterpartAccountId else counterpartAccountId
        // Standalone tills never sync, so the server's counterpart rule does not apply.
        require(!counterpart.isNullOrBlank() || config.standalone) {
            if (ctx.synced) "Select the account this cash ${if (movementType == "pay_in") "came from" else "went to"}"
            else "Sync with the server first — cash accounts have not reached this device"
        }
        if (movementType != "pay_in" && !config.standalone) {
            requireNotNull(approval) { "A manager must approve cash leaving the drawer" }
            require(approval.managerId != session.actorUserId) { "The shift's cashier cannot approve their own cash-out" }
        }
        if (movementType == "pay_out") {
            val onHand = xReport()?.expectedCash
            check(onHand == null || amount <= onHand + 0.005) { "The drawer only holds ${fmt(onHand ?: 0.0)}" }
        }
        val now = Instant.now()
        dao.insertMovement(
            LocalCashMovementEntity(
                id = opId,
                sessionLocalId = session.id,
                movementType = movementType,
                amount = amount,
                reason = reason.trim(),
                occurredAt = now.toEpochMilli(),
                syncStatus = "queued",
            ),
        )
        enqueue(opId, "cash_session.movement", actorUserId, now, buildJsonObject {
            put("sessionId", session.id) // clientId — resolved server-side
            put("movementType", movementType)
            put("amount", amount)
            put("reason", reason.trim())
            counterpart?.let { put("counterpartAccountId", it) }
            approval?.let {
                put("approvedById", it.managerId)
                put("managerPin", it.pin)
            }
        })
    }

    // ------------------------------------------------------------------ close

    /** Manager approval: a cash-out, or a close with not-counted tenders / wallet or large cash variance. */
    data class Approval(val managerId: String, val pin: String)

    /** What blocks a close right now, as a message — null when closing is allowed. */
    suspend fun closeBlocker(): String? {
        val failed = opQueue.failedNow()
        if (failed > 0) return "$failed rejected sync op(s) must be resolved on the Sync screen before closing"
        val tabs = tabDao.openCount()
        if (tabs > 0) return "$tabs open table order(s) must be settled or voided before closing"
        return null
    }

    suspend fun close(
        actorUserId: String,
        closingCounted: Double,
        varianceReason: String?,
        closingAccounts: Map<String, Double> = emptyMap(),
        uncountedAccounts: Map<String, String> = emptyMap(),
        approval: Approval? = null,
    ) {
        val session = dao.open() ?: error("No open session")
        require(closingCounted >= 0) { "Counted cash cannot be negative" }
        closeBlocker()?.let { error(it) }
        val ctx = context(session.cashRegisterId)
        val missing = ctx.trackedTenders.filter { it.accountId !in closingAccounts && it.accountId !in uncountedAccounts }
        require(missing.isEmpty()) {
            "Enter closing balances for: ${missing.joinToString { it.label }} (or mark them not counted with a reason)"
        }
        require(uncountedAccounts.values.all { it.isNotBlank() }) { "Give a reason for every tender that was not counted" }
        val x = xReport()
        val variance = x?.let { closingCounted - it.expectedCash } ?: 0.0
        val walletDiff = x?.let { rep ->
            closingAccounts.any { (acc, observed) -> abs(observed - (rep.expectedByAccount[acc] ?: 0.0)) > 0.005 }
        } ?: false
        if (abs(variance) > 0.005 || walletDiff) {
            require(!varianceReason.isNullOrBlank()) { "Explain the difference between counted and expected balances" }
        }
        if (uncountedAccounts.isNotEmpty() || walletDiff || abs(variance) >= LARGE_VARIANCE) {
            requireNotNull(approval) { "A manager must approve this close" }
        }
        require(approval == null || approval.managerId != actorUserId) { "The session cashier cannot approve their own close" }

        val now = Instant.now()
        val accountsJson = buildJsonObject { closingAccounts.forEach { (k, v) -> put(k, v) } }
        dao.close(session.id, now.toEpochMilli(), closingCounted, varianceReason, accountsJson.toString())
        enqueue(UUID.randomUUID().toString(), "cash_session.close", actorUserId, now, buildJsonObject {
            // The local id is the session's clientId — the server maps it to its
            // own id (open earlier in this batch) or it already is the server id.
            put("sessionId", session.serverId ?: session.id)
            put("closingCounted", closingCounted)
            if (closingAccounts.isNotEmpty()) put("closingAccounts", accountsJson)
            if (uncountedAccounts.isNotEmpty()) putJsonObject("uncountedAccounts") {
                uncountedAccounts.forEach { (k, v) -> put(k, v.trim()) }
            }
            varianceReason?.takeIf { it.isNotBlank() }?.let { put("varianceReason", it.trim()) }
            approval?.let {
                put("approvedById", it.managerId)
                put("managerPin", it.pin)
            }
        })
    }

    // ---------------------------------------------------------------- reports

    /** Local X-report: computed from Room, no server needed. */
    data class LocalXReport(
        val salesCount: Int,
        val salesTotal: Double,
        val openingFloat: Double,
        /** Cash the drawer should hold: float + cash takings − cash refunds ± movements. */
        val expectedCash: Double,
        /** Electronic takings per receiving account (shift-tracked wallets). */
        val expectedByAccount: Map<String, Double> = emptyMap(),
    )

    suspend fun xReport(): LocalXReport? {
        val session = dao.open() ?: return null
        val sales = saleDao.forSession(session.id)
        val takings = tenderTotals(sales)
        val cashRefunds = cashRefunds(session.id)
        val movementNet = dao.movements(session.id).sumOf {
            when (it.movementType) {
                "pay_in" -> it.amount
                "pay_out" -> -it.amount
                else -> it.amount
            }
        }
        return LocalXReport(
            salesCount = sales.size,
            salesTotal = sales.sumOf { it.total },
            openingFloat = session.openingFloat,
            expectedCash = session.openingFloat + takings.cash - cashRefunds + movementNet,
            expectedByAccount = takings.byAccount,
        )
    }

    /** Full Z-report for a specific session (open or closed), straight from Room. */
    data class LocalZReport(
        val session: LocalCashSessionEntity,
        val salesCount: Int,
        val salesTotal: Double,
        val refunds: Double,
        val payIn: Double,
        val payOut: Double,
        val expectedCash: Double,
        val counted: Double?,
        val variance: Double?,
    )

    suspend fun zReport(sessionId: String): LocalZReport? {
        val s = dao.byId(sessionId) ?: return null
        val sales = saleDao.forSession(s.id)
        val takings = tenderTotals(sales)
        val refunds = refundDao.sessionRefundTotal(s.id)
        val movements = dao.movements(s.id)
        val payIn = movements.filter { it.movementType == "pay_in" }.sumOf { it.amount }
        val payOut = movements.filter { it.movementType == "pay_out" }.sumOf { it.amount }
        val adjust = movements.filter { it.movementType == "adjustment" }.sumOf { it.amount }
        val expected = s.openingFloat + takings.cash - cashRefunds(s.id) + payIn - payOut + adjust
        return LocalZReport(
            session = s,
            salesCount = sales.size,
            salesTotal = sales.sumOf { it.total },
            refunds = refunds,
            payIn = payIn,
            payOut = payOut,
            expectedCash = expected,
            counted = s.closingCounted,
            variance = s.closingCounted?.let { it - expected },
        )
    }

    private data class Takings(val cash: Double, val byAccount: Map<String, Double>)

    /** Split session takings into drawer cash and per-account electronic money. */
    private fun tenderTotals(sales: List<LocalSaleEntity>): Takings {
        var cash = 0.0
        val byAccount = mutableMapOf<String, Double>()
        for (sale in sales) {
            for (t in tenders(sale)) {
                if (t.first == "cash") cash += t.third
                else t.second?.let { acc -> byAccount[acc] = (byAccount[acc] ?: 0.0) + t.third }
            }
        }
        return Takings(cash, byAccount)
    }

    /** Cash share of each refund, pro-rata to the refunded sale's cash tender. */
    private suspend fun cashRefunds(sessionLocalId: String): Double =
        refundDao.forSession(sessionLocalId).sumOf { r ->
            val sale = saleDao.byId(r.saleLocalId) ?: return@sumOf 0.0
            if (sale.total <= 0) return@sumOf 0.0
            val cash = tenders(sale).filter { it.first == "cash" }.sumOf { it.third }
            r.amount * (cash / sale.total).coerceIn(0.0, 1.0)
        }

    /** (method, accountId, amount) per tender leg of a sale. */
    private fun tenders(sale: LocalSaleEntity): List<Triple<String, String?, Double>> =
        runCatching {
            (json.parseToJsonElement(sale.tendersJson) as JsonArray).filterIsInstance<JsonObject>().map { t ->
                Triple(
                    t["method"]?.jsonPrimitive?.contentOrNull ?: "cash",
                    t["accountId"]?.jsonPrimitive?.contentOrNull,
                    t["amount"]?.jsonPrimitive?.contentOrNull?.toDoubleOrNull() ?: 0.0,
                )
            }
        }.getOrDefault(emptyList())

    // ---------------------------------------------------------------- helpers

    private suspend fun enqueue(opId: String, type: String, actorUserId: String, at: Instant, payload: JsonObject) {
        opQueue.enqueueNext { seq ->
            OpQueueEntity(
                opId = opId,
                deviceSeq = seq,
                type = type,
                actorUserId = actorUserId,
                occurredAt = at.toEpochMilli(),
                payloadJson = payload.toString(),
                status = "queued",
                attempts = 0,
                lastError = null,
            )
        }
    }

    private fun fmt(v: Double) = "%,.0f".format(v)

    companion object {
        /** Server default CASH_VARIANCE_APPROVAL_THRESHOLD: at/over this a manager must approve. */
        const val LARGE_VARIANCE = 20_000.0
    }
}
