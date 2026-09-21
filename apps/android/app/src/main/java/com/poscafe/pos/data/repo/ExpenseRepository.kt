package com.poscafe.pos.data.repo

import com.poscafe.pos.data.DeviceConfig
import com.poscafe.pos.data.local.dao.CashInventoryDao
import com.poscafe.pos.data.local.dao.CashSessionDao
import com.poscafe.pos.data.local.dao.ExpenseDao
import com.poscafe.pos.data.local.dao.OpQueueDao
import com.poscafe.pos.data.local.dao.SupplierDao
import com.poscafe.pos.data.local.entity.ExpenseEntity
import com.poscafe.pos.data.local.entity.OpQueueEntity
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Operating expenses, synced the way the back office books them:
 *
 *  - [Source.DRAWER]: cash from the open till. Drawers move only through their
 *    shift, so this is a `cash_session.movement` pay-out whose counterpart is
 *    the category's expense account (the op id is the expense id).
 *  - [Source.ACCOUNT]: paid from a safe, bank or mobile-money account →
 *    `expense.create` (CASH) — posted immediately, needs expense:post.
 *  - [Source.CREDIT]: owed to a payee → `expense.create` (CREDIT), approved in
 *    the back office.
 *
 * The expense row is the device's own record for the expense list/report.
 */
@Singleton
class ExpenseRepository @Inject constructor(
    private val expenseDao: ExpenseDao,
    private val cashSessionDao: CashSessionDao,
    private val cashSessions: CashSessionRepository,
    private val refs: CashInventoryDao,
    private val supplierDao: SupplierDao,
    private val opQueue: OpQueueDao,
    private val config: DeviceConfig,
) {
    enum class Source { DRAWER, ACCOUNT, CREDIT }

    suspend fun record(
        actorUserId: String?,
        /** Server category id, or null for a device-only free-text category. */
        categoryId: String?,
        categoryName: String,
        description: String?,
        amount: Double,
        source: Source,
        /** The paying account for [Source.ACCOUNT]. */
        paymentAccountId: String? = null,
        supplierId: String? = null,
        /** Manager approval — required for [Source.DRAWER] (a drawer pay-out). */
        approval: CashSessionRepository.Approval? = null,
    ): ExpenseEntity {
        require(amount > 0) { "Amount must be positive" }
        requireNotNull(actorUserId) { "Sign in to record an expense" }
        val category = categoryId?.let { refs.expenseCategory(it) }
        val session = if (source == Source.DRAWER) cashSessionDao.open() ?: error("Open a cash session to pay from the drawer") else null
        val payingAccount = paymentAccountId?.let { refs.account(it) }
        if (source == Source.ACCOUNT) {
            require(payingAccount != null && payingAccount.has("expense_payment")) { "Choose the account the expense was paid from" }
            payingAccount.balance?.let { check(it + 0.005 >= amount) { "${payingAccount.name} only has ${"%,.0f".format(it)} recorded" } }
        }

        val id = UUID.randomUUID().toString()
        val now = Instant.now().toEpochMilli()
        val method = when (source) {
            Source.DRAWER -> "cash"
            Source.CREDIT -> "credit"
            Source.ACCOUNT -> when (payingAccount?.categoryKey) {
                "bank" -> "bank"
                "mobile_money" -> "mobile_money"
                else -> "cash"
            }
        }
        val title = description?.takeIf { it.isNotBlank() }?.trim() ?: categoryName
        val synced = !config.standalone
        val expense = ExpenseEntity(
            id = id,
            category = category?.name ?: categoryName,
            description = description?.takeIf { it.isNotBlank() },
            amount = amount,
            paymentMethod = method,
            supplierId = supplierId,
            cashSessionLocalId = session?.id,
            actorUserId = actorUserId,
            occurredAt = now,
            createdAt = now,
            categoryId = category?.id,
            syncStatus = if (synced) "queued" else "local",
        )

        if (source == Source.DRAWER) {
            // The pay-out IS the expense on the server: debit the category's
            // expense account, credit the drawer. Validate before writing anything.
            val expenseAccount = category?.accountId
                ?: refs.accounts().firstOrNull { it.has("default_expense") }?.id
            require(expenseAccount != null || config.standalone) {
                "Sync first — this device has no expense account for ${category?.name ?: categoryName}"
            }
            expenseDao.insert(expense)
            runCatching {
                cashSessions.recordMovement(
                    actorUserId = actorUserId,
                    movementType = "pay_out",
                    amount = amount,
                    reason = "Expense: ${expense.category}${expense.description?.let { " — $it" } ?: ""}",
                    counterpartAccountId = expenseAccount,
                    approval = approval,
                    opId = id,
                )
            }.onFailure { expenseDao.delete(id); throw it }
            return expense
        }

        expenseDao.insert(expense)
        if (synced) {
            val payee = supplierId?.let { supplierDao.byId(it)?.name }
            opQueue.enqueueNext { seq ->
                OpQueueEntity(
                    opId = id,
                    deviceSeq = seq,
                    type = "expense.create",
                    actorUserId = actorUserId,
                    occurredAt = now,
                    payloadJson = buildJsonObject {
                        put("clientId", id)
                        put("title", title)
                        expense.description?.let { put("description", it) }
                        put("amount", amount)
                        category?.id?.let { put("categoryId", it) }
                        put("expenseDate", Instant.ofEpochMilli(now).toString())
                        // Device suppliers may exist only here, so the payee travels
                        // as a note rather than a server partner reference.
                        payee?.let { put("notes", "Payee: $it") }
                        if (source == Source.CREDIT) {
                            put("paymentType", "CREDIT")
                        } else {
                            put("paymentType", "CASH")
                            put("paymentMethod", method)
                            put("accountId", payingAccount!!.id)
                        }
                    }.toString(),
                    status = "queued",
                    attempts = 0,
                    lastError = null,
                )
            }
        }
        return expense
    }
}
