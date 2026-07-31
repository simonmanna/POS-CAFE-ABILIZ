package com.poscafe.pos.data.repo

import com.poscafe.pos.data.local.dao.MenuDao
import com.poscafe.pos.data.local.dao.TableDao
import com.poscafe.pos.data.local.entity.*
import kotlinx.serialization.json.add
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Authoring write-layer for the catalog (menu items + their variants/modifier/
 * accompaniment groups, taxes, tables). Every method is local-first: it writes
 * Room so the change is instantly live for selling, then — on a connected,
 * signed-in device — enqueues the matching master-data op via [MasterDataSync]
 * so the server converges (standalone devices simply skip the enqueue).
 */
@Singleton
class CatalogRepository @Inject constructor(
    private val menuDao: MenuDao,
    private val tableDao: TableDao,
    private val sync: MasterDataSync,
) {
    // ─────────────────────────── Categories ───────────────────────────
    suspend fun saveCategory(row: MenuCategoryEntity) {
        menuDao.upsertCategories(listOf(row))
        sync.enqueue("menuCategory.upsert", buildJsonObject {
            put("id", row.id)
            put("name", row.name)
            put("displayOrder", row.sortOrder)
            put("isActive", row.isActive)
        })
    }

    suspend fun deleteCategory(id: String) {
        menuDao.deleteCategory(id)
        sync.enqueue("menuCategory.delete", buildJsonObject { put("id", id) })
    }

    // ──────────────────────────── Menu items ──────────────────────────
    /** Persist the item plus its full aggregate (variants + group assignments)
     *  and the device-local cost/reorder meta, then queue one menuItem.upsert. */
    suspend fun saveMenuItem(
        item: MenuItemEntity,
        variants: List<MenuItemVariantEntity>,
        modifierGroupIds: List<String>,
        accompanimentGroupIds: List<String>,
        costMajor: Double?,
        reorderPoint: Double?,
    ) {
        menuDao.upsertItems(listOf(item))

        menuDao.clearVariants(item.id)
        if (variants.isNotEmpty()) menuDao.upsertVariants(variants)

        menuDao.clearItemModifierJoins(item.id)
        if (modifierGroupIds.isNotEmpty()) {
            menuDao.upsertItemModifierJoins(
                modifierGroupIds.mapIndexed { i, gid -> MenuItemModifierGroupEntity(item.id, gid, i) },
            )
        }
        menuDao.clearItemAccompanimentJoins(item.id)
        if (accompanimentGroupIds.isNotEmpty()) {
            menuDao.upsertItemAccompanimentJoins(
                accompanimentGroupIds.mapIndexed { i, gid -> MenuItemAccompanimentGroupEntity(item.id, gid, i) },
            )
        }
        menuDao.upsertLocalMeta(MenuItemLocalEntity(item.id, costMajor, reorderPoint))

        sync.enqueue("menuItem.upsert", buildJsonObject {
            put("id", item.id)
            item.code?.let { put("code", it) }
            put("name", item.name)
            item.description?.let { put("description", it) }
            item.categoryId?.let { put("categoryId", it) }
            // Server stores basePrice in MINOR units.
            CartEngine.majorToBasePrice(item.basePriceMajor)?.let { put("basePrice", it) }
            item.taxId?.let { put("taxId", it) }
            item.image?.let { put("image", it) }
            put("isAvailable", item.isAvailable)
            put("displayOrder", item.displayOrder)
            put("variants", buildJsonArray {
                variants.forEach { v ->
                    addJsonObject {
                        put("id", v.id)
                        put("name", v.name)
                        put("price", v.price)
                        put("sortOrder", v.sortOrder)
                    }
                }
            })
            put("modifierGroupIds", buildJsonArray {
                modifierGroupIds.forEachIndexed { i, gid -> addJsonObject { put("modifierGroupId", gid); put("sortOrder", i) } }
            })
            put("accompanimentGroupIds", buildJsonArray {
                accompanimentGroupIds.forEachIndexed { i, gid -> addJsonObject { put("accompanimentGroupId", gid); put("sortOrder", i) } }
            })
        })
    }

    suspend fun deleteMenuItem(id: String) {
        menuDao.deleteItem(id)
        sync.enqueue("menuItem.delete", buildJsonObject { put("id", id) })
    }

    // ───────────────────────────── Taxes ──────────────────────────────
    suspend fun saveTax(row: TaxEntity) {
        menuDao.upsertTaxes(listOf(row))
        sync.enqueue("tax.upsert", buildJsonObject {
            put("id", row.id)
            put("name", row.name)
            put("rate", row.rate)
            put("isActive", row.isActive)
        })
    }

    suspend fun deleteTax(id: String) {
        menuDao.deleteTax(id)
        sync.enqueue("tax.delete", buildJsonObject { put("id", id) })
    }

    // ─────────────────────── Modifier groups ──────────────────────────
    suspend fun saveModifierGroup(group: ModifierGroupEntity, modifiers: List<ModifierEntity>) {
        menuDao.upsertModifierGroups(listOf(group))
        menuDao.clearModifiers(group.id)
        if (modifiers.isNotEmpty()) menuDao.upsertModifiers(modifiers)
        sync.enqueue("modifierGroup.upsert", buildJsonObject {
            put("id", group.id)
            put("name", group.name)
            put("groupType", group.groupType)
            put("minSelect", group.minSelect)
            put("maxSelect", group.maxSelect)
            put("sortOrder", group.sortOrder)
            put("isActive", group.isActive)
            put("modifiers", buildJsonArray {
                modifiers.forEach { m ->
                    addJsonObject {
                        put("id", m.id)
                        put("name", m.name)
                        m.kitchenPrintName?.let { put("kitchenPrintName", it) }
                        put("priceDelta", m.priceDelta)
                        put("isDefault", m.isDefault)
                        put("sortOrder", m.sortOrder)
                    }
                }
            })
        })
    }

    suspend fun deleteModifierGroup(id: String) {
        menuDao.clearModifiers(id)
        menuDao.deleteModifierGroup(id)
        sync.enqueue("modifierGroup.delete", buildJsonObject { put("id", id) })
    }

    // ──────────────────── Accompaniment groups ────────────────────────
    suspend fun saveAccompanimentGroup(group: AccompanimentGroupEntity, options: List<AccompanimentOptionEntity>) {
        menuDao.upsertAccompanimentGroups(listOf(group))
        menuDao.clearAccompanimentOptions(group.id)
        if (options.isNotEmpty()) menuDao.upsertAccompanimentOptions(options)
        sync.enqueue("accompanimentGroup.upsert", buildJsonObject {
            put("id", group.id)
            put("name", group.name)
            put("isRequired", group.isRequired)
            put("minSelect", group.minSelect)
            put("maxSelect", group.maxSelect)
            put("sortOrder", group.sortOrder)
            put("isActive", group.isActive)
            put("options", buildJsonArray {
                options.forEach { o ->
                    addJsonObject {
                        put("id", o.id)
                        put("name", o.name)
                        put("priceImpact", o.priceImpact)
                        put("isDefault", o.isDefault)
                        put("sortOrder", o.sortOrder)
                    }
                }
            })
        })
    }

    suspend fun deleteAccompanimentGroup(id: String) {
        menuDao.clearAccompanimentOptions(id)
        menuDao.deleteAccompanimentGroup(id)
        sync.enqueue("accompanimentGroup.delete", buildJsonObject { put("id", id) })
    }

    // ───────────────────────────── Tables ─────────────────────────────
    suspend fun saveTable(row: PosTableEntity) {
        tableDao.upsertAll(listOf(row))
        sync.enqueue("posTable.upsert", buildJsonObject {
            put("id", row.id)
            // Server PosTable.number is an Int — send a numeric value.
            put("number", row.number.filter { it.isDigit() }.toIntOrNull() ?: 0)
            row.name?.let { put("name", it) } ?: put("name", row.number)
            put("sortOrder", row.sortOrder)
            put("active", row.status != "inactive")
        })
    }

    suspend fun deleteTable(id: String) {
        tableDao.delete(id)
        sync.enqueue("posTable.delete", buildJsonObject { put("id", id) })
    }
}
