package com.poscafe.pos.di

import android.content.Context
import com.jakewharton.retrofit2.converter.kotlinx.serialization.asConverterFactory
import com.poscafe.pos.data.DeviceConfig
import com.poscafe.pos.data.local.PosDatabase
import com.poscafe.pos.data.local.dao.*
import com.poscafe.pos.data.remote.SyncApi
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import retrofit2.Retrofit
import java.util.concurrent.TimeUnit
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object AppModule {

    @Provides
    @Singleton
    fun database(@ApplicationContext context: Context, config: DeviceConfig): PosDatabase =
        PosDatabase.build(context, config.dbPassphrase())

    @Provides fun menuDao(db: PosDatabase): MenuDao = db.menuDao()
    @Provides fun staffDao(db: PosDatabase): StaffDao = db.staffDao()
    @Provides fun tableDao(db: PosDatabase): TableDao = db.tableDao()
    @Provides fun registerDao(db: PosDatabase): RegisterDao = db.registerDao()
    @Provides fun settingsDao(db: PosDatabase): SettingsDao = db.settingsDao()
    @Provides fun syncStateDao(db: PosDatabase): SyncStateDao = db.syncStateDao()
    @Provides fun saleDao(db: PosDatabase): SaleDao = db.saleDao()
    @Provides fun cashSessionDao(db: PosDatabase): CashSessionDao = db.cashSessionDao()
    @Provides fun opQueueDao(db: PosDatabase): OpQueueDao = db.opQueueDao()
    @Provides fun customerDao(db: PosDatabase): CustomerDao = db.customerDao()
    @Provides fun supplierDao(db: PosDatabase): SupplierDao = db.supplierDao()
    @Provides fun inventoryDao(db: PosDatabase): InventoryDao = db.inventoryDao()
    @Provides fun purchaseDao(db: PosDatabase): PurchaseDao = db.purchaseDao()
    @Provides fun expenseDao(db: PosDatabase): ExpenseDao = db.expenseDao()
    @Provides fun productDao(db: PosDatabase): ProductDao = db.productDao()
    @Provides fun productCategoryDao(db: PosDatabase): ProductCategoryDao = db.productCategoryDao()
    @Provides fun holdDao(db: PosDatabase): HoldDao = db.holdDao()
    @Provides fun refundDao(db: PosDatabase): RefundDao = db.refundDao()
    @Provides fun tabDao(db: PosDatabase): TabDao = db.tabDao()
    @Provides fun productPackagingDao(db: PosDatabase): ProductPackagingDao = db.productPackagingDao()
    @Provides fun reservationDao(db: PosDatabase): ReservationDao = db.reservationDao()
    @Provides fun conversationDao(db: PosDatabase): ConversationDao = db.conversationDao()
    @Provides fun messageDao(db: PosDatabase): MessageDao = db.messageDao()
    @Provides fun conversationReadStateDao(db: PosDatabase): ConversationReadStateDao = db.conversationReadStateDao()

    /**
     * Retrofit is built once, but the server URL is device config the cashier
     * can change at any time (LAN today, cloud tomorrow, new router IP next
     * week). This interceptor rewrites the host/port/scheme of every request
     * from the CURRENT config, so a URL change takes effect immediately —
     * no app restart, no reinstall. Retrofit's own baseUrl is only a
     * placeholder to satisfy its builder.
     */
    private class DynamicHostInterceptor(private val config: DeviceConfig) : Interceptor {
        override fun intercept(chain: Interceptor.Chain): okhttp3.Response {
            val request = chain.request()
            val base = config.serverUrl?.toHttpUrlOrNull()
                ?: return chain.proceed(request) // not configured yet — let it fail loudly

            // Keep the path Retrofit built (e.g. "sync/pull") but re-root it
            // under the configured base path (e.g. "/api/v1/").
            val rebuilt = request.url.newBuilder()
                .scheme(base.scheme)
                .host(base.host)
                .port(base.port)
                .build()

            val builder = request.newBuilder().url(rebuilt)
            config.deviceToken?.let { builder.header("X-Device-Token", it) }
            return chain.proceed(builder.build())
        }
    }

    @Provides
    @Singleton
    fun okHttp(config: DeviceConfig): OkHttpClient =
        OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .addInterceptor(DynamicHostInterceptor(config))
            .build()

    @Provides
    @Singleton
    fun syncApi(client: OkHttpClient, config: DeviceConfig): SyncApi {
        val json = Json { ignoreUnknownKeys = true }
        // Placeholder base — the real host comes from DynamicHostInterceptor.
        // The PATH portion still matters, so it mirrors the API's api/v1 prefix.
        val base = (config.serverUrl ?: "http://localhost:3000/api/v1/").let {
            if (it.endsWith("/")) it else "$it/"
        }
        return Retrofit.Builder()
            .baseUrl(base)
            .client(client)
            .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
            .build()
            .create(SyncApi::class.java)
    }
}
