package com.cafe.pos.data.connectivity

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Network connectivity as a [Flow]. Emits the current connectivity state
 * immediately on collect, then re-emits whenever the underlying network
 * changes (Wi-Fi ↔ cellular, lost, validated, etc.).
 *
 * "Connected" means: there's at least one active network that has the
 * `INTERNET` capability *and* is validated by the platform. That's the
 * signal the [com.cafe.pos.data.sync.SyncWorker] uses to decide whether
 * to attempt a drain.
 */
@Singleton
class NetworkConnectivityMonitor @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    private val connectivityManager: ConnectivityManager =
        context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    val isConnected: Flow<Boolean> = callbackFlow {
        // Seed with the current value.
        trySend(currentlyConnected())

        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()

        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) { trySend(true) }
            override fun onLost(network: Network) { trySend(currentlyConnected()) }
            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                trySend(currentlyConnected())
            }
        }
        connectivityManager.registerNetworkCallback(request, callback)
        awaitClose { connectivityManager.unregisterNetworkCallback(callback) }
    }
        .distinctUntilChanged()
        .stateIn(scope, SharingStarted.Eagerly, currentlyConnected())

    /** Snapshot for one-shot checks. */
    fun isConnectedNow(): Boolean = currentlyConnected()

    private fun currentlyConnected(): Boolean {
        val active = connectivityManager.activeNetwork ?: return false
        val caps = connectivityManager.getNetworkCapabilities(active) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }
}