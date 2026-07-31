package com.poscafe.pos.data.repo

import com.poscafe.pos.data.local.dao.RegisterDao
import com.poscafe.pos.data.local.entity.CashRegisterEntity
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Authoring write-layer for cash registers. Local-first; enqueues
 * cashRegister.upsert / cashRegister.delete on connected devices. isActive and
 * sortOrder are device-local presentation concerns (the open-session picker
 * hides inactive ones), so they are not part of the server op payload.
 */
@Singleton
class RegisterRepository @Inject constructor(
    private val registerDao: RegisterDao,
    private val sync: MasterDataSync,
) {
    suspend fun save(row: CashRegisterEntity) {
        registerDao.upsert(row)
        sync.enqueue("cashRegister.upsert", buildJsonObject {
            put("id", row.id)
            put("code", row.code)
            row.name?.let { put("name", it) }
        })
    }

    suspend fun delete(id: String) {
        registerDao.delete(id)
        sync.enqueue("cashRegister.delete", buildJsonObject { put("id", id) })
    }
}
