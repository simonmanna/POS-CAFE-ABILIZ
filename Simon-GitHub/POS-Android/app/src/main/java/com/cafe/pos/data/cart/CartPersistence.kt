package com.cafe.pos.data.cart

import android.content.Context
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.cafe.pos.data.local.CafePosDatabase
import com.cafe.pos.data.model.CheckoutLineDto
import com.cafe.pos.domain.cart.CartStore
import com.squareup.moshi.Moshi
import com.squareup.moshi.Types
import com.squareup.moshi.kotlin.reflect.KotlinJsonAdapterFactory
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.firstOrNull
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import javax.inject.Inject
import javax.inject.Singleton

private val Context.cartDataStore by preferencesDataStore(name = "cart_state")

/**
 * Persists the active [CartStore.State] to a small DataStore so the cart
 * survives process death. Restored at app start in [com.cafe.pos.CafePosApplication].
 *
 * Failure modes:
 *  - The DataStore file is corrupted → the cache is discarded and the
 *    cart starts empty. We never block checkout on a load failure.
 *  - The cart has a `cashSessionId` from a previous shift that is no longer
 *    open → `restore()` drops the cart and lets the cashier start fresh.
 */
@Singleton
class CartPersistence @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val moshi: Moshi = Moshi.Builder().add(KotlinJsonAdapterFactory()).build()
    private val lineListType = Types.newParameterizedType(List::class.java, CheckoutLineDto::class.java)
    private val lineAdapter = moshi.adapter<List<CheckoutLineDto>>(lineListType)

    private val cartKey = stringPreferencesKey("cart_lines")
    private val txDiscountKey = stringPreferencesKey("tx_discount")
    private val partnerIdKey = stringPreferencesKey("partner_id")

    /**
     * Read the cached cart and reapply it to [cart]. Drops the cache if
     * the JSON can't be parsed.
     */
    suspend fun restore(cart: CartStore) {
        val prefs = try {
            context.cartDataStore.data.firstOrNull()
        } catch (_: Throwable) { null } ?: return
        val linesJson = prefs[cartKey] ?: return
        val lines = try { lineAdapter.fromJson(linesJson) } catch (_: Throwable) { null } ?: return
        val txDiscount = prefs[txDiscountKey]?.toDoubleOrNull() ?: 0.0
        val partnerId = prefs[partnerIdKey]
        cart.loadFromPersistence(lines, txDiscount, partnerId)
    }

    /**
     * Write the current state to DataStore. Called by [com.cafe.pos.CafePosApplication]
     * on every cart mutation, debounced by a 250ms delay so a flurry of
     * taps doesn't thrash the disk.
     */
    fun saveDebounced(cart: CartStore) {
        scope.launch {
            kotlinx.coroutines.delay(250)
            val lines = cart.toCheckoutLines()
            context.cartDataStore.edit { prefs ->
                prefs[cartKey] = lineAdapter.toJson(lines)
                prefs[txDiscountKey] = cart.state.value.transactionDiscountPercent.toString()
                val partnerId = cart.state.value.partnerId
                if (partnerId != null) prefs[partnerIdKey] = partnerId
                else prefs.remove(partnerIdKey)
            }
        }
    }

    /** Wipe the cached cart (called after a successful checkout). */
    suspend fun clear() {
        context.cartDataStore.edit { it.clear() }
    }
}