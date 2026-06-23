package com.cafe.pos.telemetry

import android.content.Context
import com.cafe.pos.data.auth.TokenStore
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.firstOrNull
import kotlinx.coroutines.launch
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Reference implementation of [CrashReporter] that shows the pattern for
 * wiring a real crash backend. Drop the `SentryCrashReporter` class into
 * [TelemetryModule] once the Sentry SDK is on the classpath.
 *
 * The class itself does not import the Sentry SDK — that keeps the app
 * buildable without it. To enable:
 *
 *   1. Add `io.sentry:sentry-android:7.x.x` to `libs.versions.toml` and
 *      `app/build.gradle.kts`.
 *   2. Initialize Sentry in [com.cafe.pos.CafePosApplication.onCreate]:
 *      `SentryAndroid.init(context) { it.dsn = "https://...@sentry.io/..." }`.
 *   3. Uncomment the `Sentry.captureException(...)` lines below.
 *   4. Replace the binding in [TelemetryModule] with this class.
 *
 * Why not just use the Sentry SDK today? The CI doesn't have a Sentry DSN
 * secret, and shipping a crash reporter that no-ops is the safer default.
 */
@Singleton
class SentryCrashReporter @Inject constructor(
    @ApplicationContext private val context: Context,
    private val tokenStore: TokenStore,
) : CrashReporter {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun report(throwable: Throwable, tags: Map<String, String>) {
        scope.launch {
            try {
                val email = tokenStore.userEmailFlow.firstOrNull()

                // === UNCOMMENT after adding the Sentry dependency ===
                //
                // Sentry.withScope { scope ->
                //     scope.user = User().apply { this.email = email }
                //     tags.forEach { (k, v) -> scope.setTag(k, v) }
                //     Sentry.captureException(throwable)
                // }

                // Until then, log so we don't lose the crash entirely.
                android.util.Log.e("SentryCrashReporter",
                    "would report: $throwable tags=$tags email=$email", throwable)
            } catch (t: Throwable) {
                android.util.Log.e("SentryCrashReporter", "reporter itself failed", t)
            }
        }
    }

    override fun setUser(id: String?, email: String?) {
        // === UNCOMMENT ===
        // Sentry.setUser(User().apply { this.id = id; this.email = email })
        android.util.Log.i("SentryCrashReporter", "setUser: id=$id email=$email")
    }
}