package com.poscafe.pos.data.repo

import com.poscafe.pos.data.local.dao.CashSessionDao
import com.poscafe.pos.data.local.dao.ExpenseDao
import com.poscafe.pos.data.local.entity.ExpenseEntity
import java.time.Instant
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Operating expenses. The expense row is the record the expense report reads.
 * When it is paid in cash and a drawer session is open we ALSO write a
 * pay_out cash movement (via the existing session repo) so the X-report and
 * closing variance reflect the money actually leaving the till — the two
 * lenses (expense ledger vs. physical drawer) stay consistent.
 */
@Singleton
class ExpenseRepository @Inject constructor(
    private val expenseDao: ExpenseDao,
    private val cashSessionDao: CashSessionDao,
    private val cashSessions: CashSessionRepository,
) {
    suspend fun record(
        actorUserId: String?,
        category: String,
        description: String?,
        amount: Double,
        paymentMethod: String,
        supplierId: String?,
    ): ExpenseEntity {
        require(amount > 0) { "Amount must be positive" }
        val openSession = if (paymentMethod == "cash") cashSessionDao.open() else null
        val now = Instant.now().toEpochMilli()
        val expense = ExpenseEntity(
            id = UUID.randomUUID().toString(),
            category = category,
            description = description?.takeIf { it.isNotBlank() },
            amount = amount,
            paymentMethod = paymentMethod,
            supplierId = supplierId,
            cashSessionLocalId = openSession?.id,
            actorUserId = actorUserId,
            occurredAt = now,
            createdAt = now,
        )
        expenseDao.insert(expense)
        // Cash expense against an open drawer → mirror as a pay_out movement.
        if (openSession != null && actorUserId != null) {
            runCatching {
                cashSessions.recordMovement(
                    actorUserId = actorUserId,
                    movementType = "pay_out",
                    amount = amount,
                    reason = "Expense: ${category}${description?.let { " — $it" } ?: ""}",
                )
            }
        }
        return expense
    }
}
