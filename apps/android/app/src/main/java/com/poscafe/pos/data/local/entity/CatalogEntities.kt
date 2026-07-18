package com.poscafe.pos.data.local.entity

import androidx.room.Entity
import androidx.room.PrimaryKey

/**
 * Local mirror of the server catalog, populated by /sync/pull. The device is
 * read-only over these — the server always wins (conflict rule: catalog =
 * server-authoritative). Aggregate children are flattened into rows keyed by
 * their server uuid, so a re-pulled MenuItem aggregate replaces them wholesale.
 */
@Entity(tableName = "menu_categories")
data class MenuCategoryEntity(
    @PrimaryKey val id: String,
    val name: String,
    val sortOrder: Int,
    val isActive: Boolean,
)

@Entity(tableName = "menu_items")
data class MenuItemEntity(
    @PrimaryKey val id: String,
    val code: String?,
    val name: String,
    val description: String?,
    val categoryId: String?,
    /** Server stores basePrice in MINOR units (×100); everything else MAJOR.
     *  Converted to MAJOR here at pull-apply time so the app math is uniform. */
    val basePriceMajor: Double?,
    val taxId: String?,
    val image: String?,
    val isAvailable: Boolean,
    val displayOrder: Int,
)

@Entity(tableName = "menu_item_variants")
data class MenuItemVariantEntity(
    @PrimaryKey val id: String,
    val menuItemId: String,
    val name: String,
    /** Absolute price replacing the base price when selected (MAJOR units). */
    val price: Double,
    val sortOrder: Int,
    val isActive: Boolean,
)

@Entity(tableName = "modifier_groups")
data class ModifierGroupEntity(
    @PrimaryKey val id: String,
    val name: String,
    /** ADD_ON (paid extras) or MODIFIER (prep instructions). */
    val groupType: String,
    val minSelect: Int,
    val maxSelect: Int,
    val sortOrder: Int,
    val isActive: Boolean,
)

@Entity(tableName = "modifiers")
data class ModifierEntity(
    @PrimaryKey val id: String,
    val groupId: String,
    val name: String,
    val kitchenPrintName: String?,
    /** Signed price delta (MAJOR units). */
    val priceDelta: Double,
    val isDefault: Boolean,
    val sortOrder: Int,
    val isActive: Boolean,
)

/** Join: which modifier groups apply to a menu item. */
@Entity(tableName = "menu_item_modifier_groups", primaryKeys = ["menuItemId", "modifierGroupId"])
data class MenuItemModifierGroupEntity(
    val menuItemId: String,
    val modifierGroupId: String,
    val sortOrder: Int,
)

@Entity(tableName = "accompaniment_groups")
data class AccompanimentGroupEntity(
    @PrimaryKey val id: String,
    val name: String,
    val isRequired: Boolean,
    val minSelect: Int,
    val maxSelect: Int,
    val sortOrder: Int,
    val isActive: Boolean,
)

@Entity(tableName = "accompaniment_options")
data class AccompanimentOptionEntity(
    @PrimaryKey val id: String,
    val groupId: String,
    val name: String,
    /** 0 = included; >0 = upcharge (MAJOR units). */
    val priceImpact: Double,
    val isDefault: Boolean,
    val sortOrder: Int,
    val isActive: Boolean,
)

@Entity(tableName = "menu_item_accompaniment_groups", primaryKeys = ["menuItemId", "accompanimentGroupId"])
data class MenuItemAccompanimentGroupEntity(
    val menuItemId: String,
    val accompanimentGroupId: String,
    val sortOrder: Int,
)

@Entity(tableName = "taxes")
data class TaxEntity(
    @PrimaryKey val id: String,
    val name: String,
    /** Percent, e.g. 18.0 for VAT 18%. */
    val rate: Double,
    val isActive: Boolean,
)

@Entity(tableName = "pos_tables")
data class PosTableEntity(
    @PrimaryKey val id: String,
    val number: String,
    val name: String?,
    val status: String,
    val sortOrder: Int,
)

@Entity(tableName = "cash_registers")
data class CashRegisterEntity(
    @PrimaryKey val id: String,
    val code: String,
    val name: String?,
)

/**
 * Staff for OFFLINE PIN login. Only the bcrypt pinHash ever reaches the
 * device (never password hashes); the whole DB is SQLCipher-encrypted with a
 * Keystore-held key, and a revoked device wipes on next server contact.
 */
@Entity(tableName = "staff")
data class StaffEntity(
    @PrimaryKey val id: String,
    val firstName: String,
    val lastName: String?,
    val email: String,
    val pinHash: String?,
    val permissions: String, // comma-joined
    val isActive: Boolean,
)

@Entity(tableName = "settings")
data class SettingEntity(
    @PrimaryKey val key: String,
    val valueJson: String,
)

/** One row per pull scope: the opaque watermark cursor from the server. */
@Entity(tableName = "sync_state")
data class SyncStateEntity(
    @PrimaryKey val id: Int = 1,
    val cursor: String?,
    val lastPullAt: Long?,
    val lastPushAt: Long?,
)
