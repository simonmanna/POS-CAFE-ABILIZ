package com.poscafe.pos.data.local

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase
import com.poscafe.pos.data.local.dao.*
import com.poscafe.pos.data.local.entity.*
import net.zetetic.database.sqlcipher.SupportOpenHelperFactory

@Database(
    entities = [
        MenuCategoryEntity::class,
        MenuItemEntity::class,
        MenuItemVariantEntity::class,
        ModifierGroupEntity::class,
        ModifierEntity::class,
        MenuItemModifierGroupEntity::class,
        AccompanimentGroupEntity::class,
        AccompanimentOptionEntity::class,
        MenuItemAccompanimentGroupEntity::class,
        TaxEntity::class,
        PosTableEntity::class,
        CashRegisterEntity::class,
        StaffEntity::class,
        SettingEntity::class,
        SyncStateEntity::class,
        LocalSaleEntity::class,
        LocalRefundEntity::class,
        LocalCashSessionEntity::class,
        LocalCashMovementEntity::class,
        OpQueueEntity::class,
        CustomerEntity::class,
        SupplierEntity::class,
        InventoryMovementEntity::class,
        PurchaseEntity::class,
        PurchaseItemEntity::class,
        ExpenseEntity::class,
        ProductEntity::class,
        ProductCategoryEntity::class,
        ProductPackagingEntity::class,
        LocalHoldEntity::class,
        LocalTabEntity::class,
        ReservationEntity::class,
        MenuItemLocalEntity::class,
        ConversationEntity::class,
        MessageEntity::class,
        ConversationReadStateEntity::class,
        PaymentMethodEntity::class,
        LedgerAccountEntity::class,
        ExpenseCategoryEntity::class,
        StockLocationEntity::class,
        StockLevelEntity::class,
    ],
    version = 12,
    exportSchema = true,
)
abstract class PosDatabase : RoomDatabase() {
    abstract fun menuDao(): MenuDao
    abstract fun staffDao(): StaffDao
    abstract fun tableDao(): TableDao
    abstract fun registerDao(): RegisterDao
    abstract fun settingsDao(): SettingsDao
    abstract fun syncStateDao(): SyncStateDao
    abstract fun saleDao(): SaleDao
    abstract fun refundDao(): RefundDao
    abstract fun cashSessionDao(): CashSessionDao
    abstract fun opQueueDao(): OpQueueDao
    abstract fun customerDao(): CustomerDao
    abstract fun supplierDao(): SupplierDao
    abstract fun inventoryDao(): InventoryDao
    abstract fun purchaseDao(): PurchaseDao
    abstract fun expenseDao(): ExpenseDao
    abstract fun productDao(): ProductDao
    abstract fun productCategoryDao(): ProductCategoryDao
    abstract fun productPackagingDao(): ProductPackagingDao
    abstract fun holdDao(): HoldDao
    abstract fun tabDao(): TabDao
    abstract fun reservationDao(): ReservationDao
    abstract fun conversationDao(): ConversationDao
    abstract fun messageDao(): MessageDao
    abstract fun conversationReadStateDao(): ConversationReadStateDao
    abstract fun cashInventoryDao(): CashInventoryDao

    companion object {
        /** v1 → v2: additive only (customers, suppliers, inventory movements) —
         *  existing sales/session data must survive the upgrade. */
        val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `customers` (`id` TEXT NOT NULL, `name` TEXT NOT NULL, " +
                        "`phone` TEXT, `email` TEXT, `note` TEXT, `loyaltyPoints` INTEGER NOT NULL, " +
                        "`createdAt` INTEGER NOT NULL, PRIMARY KEY(`id`))",
                )
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `suppliers` (`id` TEXT NOT NULL, `name` TEXT NOT NULL, " +
                        "`phone` TEXT, `note` TEXT, `createdAt` INTEGER NOT NULL, PRIMARY KEY(`id`))",
                )
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `inventory_movements` (`id` TEXT NOT NULL, " +
                        "`menuItemId` TEXT NOT NULL, `type` TEXT NOT NULL, `qtyDelta` REAL NOT NULL, " +
                        "`unitCost` REAL, `supplierId` TEXT, `reason` TEXT, `saleLocalId` TEXT, " +
                        "`actorUserId` TEXT, `occurredAt` INTEGER NOT NULL, PRIMARY KEY(`id`))",
                )
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_inventory_movements_menuItemId` ON `inventory_movements` (`menuItemId`)")
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_inventory_movements_occurredAt` ON `inventory_movements` (`occurredAt`)")
            }
        }

        /** v2 → v3: purchase documents + expense tracker (additive). */
        val MIGRATION_2_3 = object : Migration(2, 3) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE `inventory_movements` ADD COLUMN `purchaseId` TEXT")
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `purchases` (`id` TEXT NOT NULL, `supplierId` TEXT, " +
                        "`reference` TEXT, `status` TEXT NOT NULL, `totalCost` REAL NOT NULL, `note` TEXT, " +
                        "`actorUserId` TEXT, `occurredAt` INTEGER NOT NULL, `createdAt` INTEGER NOT NULL, PRIMARY KEY(`id`))",
                )
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_purchases_occurredAt` ON `purchases` (`occurredAt`)")
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `purchase_items` (`id` TEXT NOT NULL, `purchaseId` TEXT NOT NULL, " +
                        "`menuItemId` TEXT NOT NULL, `name` TEXT NOT NULL, `quantity` REAL NOT NULL, " +
                        "`unitCost` REAL NOT NULL, `lineTotal` REAL NOT NULL, PRIMARY KEY(`id`))",
                )
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_purchase_items_purchaseId` ON `purchase_items` (`purchaseId`)")
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `expenses` (`id` TEXT NOT NULL, `category` TEXT NOT NULL, " +
                        "`description` TEXT, `amount` REAL NOT NULL, `paymentMethod` TEXT NOT NULL, " +
                        "`supplierId` TEXT, `cashSessionLocalId` TEXT, `actorUserId` TEXT, " +
                        "`occurredAt` INTEGER NOT NULL, `createdAt` INTEGER NOT NULL, PRIMARY KEY(`id`))",
                )
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_expenses_occurredAt` ON `expenses` (`occurredAt`)")
            }
        }

        /** v3 → v4: retail products + holds + nullable productId on movements/purchases. */
        val MIGRATION_3_4 = object : Migration(3, 4) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `products` (`id` TEXT NOT NULL, `code` TEXT, `sku` TEXT, " +
                        "`barcode` TEXT, `name` TEXT NOT NULL, `description` TEXT, `image` TEXT, " +
                        "`salesPrice` REAL NOT NULL, `costPrice` REAL NOT NULL, `categoryId` TEXT, " +
                        "`categoryName` TEXT, `uomName` TEXT, `taxId` TEXT, `taxRate` REAL NOT NULL, " +
                        "`taxInclusive` INTEGER NOT NULL, `isActive` INTEGER NOT NULL, `isService` INTEGER NOT NULL, " +
                        "`updatedAt` INTEGER NOT NULL, PRIMARY KEY(`id`))",
                )
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `product_categories` (`id` TEXT NOT NULL, `name` TEXT NOT NULL, " +
                        "`parentId` TEXT, PRIMARY KEY(`id`))",
                )
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `local_holds` (`id` TEXT NOT NULL, `name` TEXT NOT NULL, " +
                        "`linesJson` TEXT NOT NULL, `totalAmount` REAL NOT NULL, `partnerId` TEXT, " +
                        "`actorUserId` TEXT, `createdAt` INTEGER NOT NULL, `syncStatus` TEXT NOT NULL, PRIMARY KEY(`id`))",
                )
                db.execSQL("ALTER TABLE `inventory_movements` ADD COLUMN `productId` TEXT")
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_inventory_movements_productId` ON `inventory_movements` (`productId`)")
                db.execSQL("ALTER TABLE `purchase_items` ADD COLUMN `productId` TEXT")
            }
        }

        /** v4 → v5: customer sync bookkeeping (additive). */
        val MIGRATION_4_5 = object : Migration(4, 5) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE `customers` ADD COLUMN `updatedAt` INTEGER NOT NULL DEFAULT 0")
                db.execSQL("ALTER TABLE `customers` ADD COLUMN `syncStatus` TEXT NOT NULL DEFAULT 'local'")
            }
        }

        /** v5 → v6: offline refunds/voids (additive). Sales survive the upgrade. */
        val MIGRATION_5_6 = object : Migration(5, 6) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `local_refunds` (`id` TEXT NOT NULL, " +
                        "`saleLocalId` TEXT NOT NULL, `serverInvoiceId` TEXT, `type` TEXT NOT NULL, " +
                        "`reason` TEXT, `amount` REAL NOT NULL, `overrideById` TEXT, " +
                        "`cashSessionLocalId` TEXT, `occurredAt` INTEGER NOT NULL, " +
                        "`syncStatus` TEXT NOT NULL, `lastError` TEXT, PRIMARY KEY(`id`))",
                )
            }
        }

        /** v6 → v7: offline dine-in tabs (additive). */
        val MIGRATION_6_7 = object : Migration(6, 7) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `local_tabs` (`tableId` TEXT NOT NULL, " +
                        "`linesJson` TEXT NOT NULL, `guestCount` INTEGER NOT NULL, `partnerId` TEXT, " +
                        "`firedLineIdsJson` TEXT NOT NULL, `openedAt` INTEGER NOT NULL, " +
                        "`updatedAt` INTEGER NOT NULL, `actorUserId` TEXT, PRIMARY KEY(`tableId`))",
                )
            }
        }

        /** v7 → v8: retail multipack barcodes (additive). */
        val MIGRATION_7_8 = object : Migration(7, 8) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `product_packagings` (`id` TEXT NOT NULL, " +
                        "`productId` TEXT NOT NULL, `name` TEXT NOT NULL, `quantity` REAL NOT NULL, " +
                        "`barcode` TEXT, `isActive` INTEGER NOT NULL, PRIMARY KEY(`id`))",
                )
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_product_packagings_productId` ON `product_packagings` (`productId`)")
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_product_packagings_barcode` ON `product_packagings` (`barcode`)")
            }
        }

        /** v8 → v9: table reservations (additive, synced + device-writable). */
        val MIGRATION_8_9 = object : Migration(8, 9) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `reservations` (`id` TEXT NOT NULL, " +
                        "`tableId` TEXT NOT NULL, `customerName` TEXT NOT NULL, `phone` TEXT, " +
                        "`partySize` INTEGER NOT NULL, `startAt` INTEGER NOT NULL, `endAt` INTEGER NOT NULL, " +
                        "`status` TEXT NOT NULL, `notes` TEXT, `seatedOrderId` TEXT, " +
                        "`syncStatus` TEXT NOT NULL, `updatedAt` INTEGER NOT NULL, PRIMARY KEY(`id`))",
                )
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_reservations_tableId` ON `reservations` (`tableId`)")
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_reservations_startAt` ON `reservations` (`startAt`)")
            }
        }

        /** v9 → v10: on-device master-data authoring (additive). Adds register
         *  activation/ordering + a device-local menu-item cost/reorder side table. */
        val MIGRATION_9_10 = object : Migration(9, 10) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE `cash_registers` ADD COLUMN `isActive` INTEGER NOT NULL DEFAULT 1")
                db.execSQL("ALTER TABLE `cash_registers` ADD COLUMN `sortOrder` INTEGER NOT NULL DEFAULT 0")
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `menu_item_local` (`menuItemId` TEXT NOT NULL, " +
                        "`costMajor` REAL, `reorderPoint` REAL, PRIMARY KEY(`menuItemId`))",
                )
            }
        }

        /** v10 → v11: offline staff messaging (additive). Sales/session data must
         *  survive — this migration is written explicitly even though
         *  fallbackToDestructiveMigration() is set, or a bump would wipe the till. */
        val MIGRATION_10_11 = object : Migration(10, 11) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `conversations` (`id` TEXT NOT NULL, `title` TEXT NOT NULL, " +
                        "`type` TEXT NOT NULL, `lastMessageAt` INTEGER NOT NULL, `lastMessagePreview` TEXT, " +
                        "`updatedAt` INTEGER NOT NULL, PRIMARY KEY(`id`))",
                )
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `messages` (`id` TEXT NOT NULL, `conversationId` TEXT NOT NULL, " +
                        "`senderUserId` TEXT, `senderName` TEXT NOT NULL, `direction` TEXT NOT NULL, " +
                        "`body` TEXT NOT NULL, `occurredAt` INTEGER NOT NULL, `seq` INTEGER, " +
                        "`deliveryState` TEXT NOT NULL, `lastError` TEXT, PRIMARY KEY(`id`))",
                )
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_messages_conversationId` ON `messages` (`conversationId`)")
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_messages_seq` ON `messages` (`seq`)")
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_messages_occurredAt` ON `messages` (`occurredAt`)")
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `conversation_read_state` (`conversationId` TEXT NOT NULL, " +
                        "`userId` TEXT NOT NULL, `lastReadAt` INTEGER NOT NULL, " +
                        "PRIMARY KEY(`conversationId`, `userId`))",
                )
            }
        }

        /** v11 → v12: server cash & inventory reference data (tender methods,
         *  ledger accounts, expense categories, stock locations/levels) plus sync
         *  bookkeeping on expenses/purchases. Additive — the till survives. */
        val MIGRATION_11_12 = object : Migration(11, 12) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `payment_methods` (`id` TEXT NOT NULL, `code` TEXT NOT NULL, " +
                        "`label` TEXT NOT NULL, `kind` TEXT NOT NULL, `accountId` TEXT, `accountName` TEXT, " +
                        "`requiresReference` INTEGER NOT NULL, `trackInShift` INTEGER NOT NULL, " +
                        "`sortOrder` INTEGER NOT NULL, PRIMARY KEY(`id`))",
                )
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `ledger_accounts` (`id` TEXT NOT NULL, `code` TEXT NOT NULL, " +
                        "`name` TEXT NOT NULL, `categoryKey` TEXT, `classification` TEXT, " +
                        "`isCashEquivalent` INTEGER NOT NULL, `balance` REAL, `roles` TEXT NOT NULL, PRIMARY KEY(`id`))",
                )
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `expense_categories` (`id` TEXT NOT NULL, `name` TEXT NOT NULL, " +
                        "`accountId` TEXT, PRIMARY KEY(`id`))",
                )
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `stock_locations` (`id` TEXT NOT NULL, `code` TEXT NOT NULL, " +
                        "`name` TEXT NOT NULL, `type` TEXT NOT NULL, PRIMARY KEY(`id`))",
                )
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `stock_levels` (`id` TEXT NOT NULL, `productId` TEXT NOT NULL, " +
                        "`variantId` TEXT, `locationId` TEXT NOT NULL, `quantity` REAL NOT NULL, " +
                        "`updatedAt` INTEGER NOT NULL, PRIMARY KEY(`id`))",
                )
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_stock_levels_productId` ON `stock_levels` (`productId`)")
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_stock_levels_locationId` ON `stock_levels` (`locationId`)")
                db.execSQL("ALTER TABLE `cash_registers` ADD COLUMN `defaultAccountId` TEXT")
                db.execSQL("ALTER TABLE `cash_registers` ADD COLUMN `locationId` TEXT")
                db.execSQL("ALTER TABLE `local_cash_sessions` ADD COLUMN `closingAccountsJson` TEXT")
                db.execSQL("ALTER TABLE `expenses` ADD COLUMN `categoryId` TEXT")
                db.execSQL("ALTER TABLE `expenses` ADD COLUMN `syncStatus` TEXT NOT NULL DEFAULT 'local'")
                db.execSQL("ALTER TABLE `expenses` ADD COLUMN `lastError` TEXT")
                db.execSQL("ALTER TABLE `purchases` ADD COLUMN `syncStatus` TEXT NOT NULL DEFAULT 'local'")
            }
        }

        /** SQLCipher-encrypted. Passphrase stored in EncryptedSharedPreferences
         *  (Android Keystore-backed) — stolen device yields ciphertext only. */
        fun build(context: Context, passphrase: ByteArray): PosDatabase {
            System.loadLibrary("sqlcipher")
            return Room.databaseBuilder(context, PosDatabase::class.java, "pos-cafe.db")
                .openHelperFactory(SupportOpenHelperFactory(passphrase))
                .addMigrations(
                    MIGRATION_1_2, MIGRATION_2_3, MIGRATION_3_4, MIGRATION_4_5, MIGRATION_5_6,
                    MIGRATION_6_7, MIGRATION_7_8, MIGRATION_8_9, MIGRATION_9_10, MIGRATION_10_11,
                    MIGRATION_11_12,
                )
                .fallbackToDestructiveMigration()
                .build()
        }
    }
}
