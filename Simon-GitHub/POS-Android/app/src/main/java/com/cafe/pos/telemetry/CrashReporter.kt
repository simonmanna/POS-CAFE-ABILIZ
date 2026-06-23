package com.cafe.pos.telemetry

import javax.inject.Inject
import javax.inject.Singleton

/**
 * Crash-reporting hook. The production wire-up is intentionally
 * Sentry-or-Bugsnag-agnostic: a real deployment will replace
 * [ConsoleCrashReporter] with an adapter that ships events to the
 * crash backend (Sentry.captureException, Firebase.recordException, etc.).
 *
 * The interface is deliberately narrow — [report] is the only method the
 * app actually needs. Call sites:
 *
 *   - [com.cafe.pos.CafePosApplication] installs a Thread.UncaughtExceptionHandler
 *     that forwards fatal crashes.
 *   - [com.cafe.pos.hardware.HardwareAbstractions] reports non-fatal
 *     hardware failures (printer disconnected, NFC error) so they're
 *     searchable in the crash backend.
 *
 * If no reporter is bound, [NoopCrashReporter] is used and events are
 * silently dropped.
 */
interface CrashReporter {
    fun report(throwable: Throwable, tags: Map<String, String> = emptyMap())
    fun setUser(id: String?, email: String? = null)
}

/** Default: print to logcat only. Replace in the production module. */
@Singleton
class ConsoleCrashReporter @Inject constructor() : CrashReporter {
    override fun report(throwable: Throwable, tags: Map<String, String>) {
        android.util.Log.e("Crash", "report: $throwable tags=$tags", throwable)
    }
    override fun setUser(id: String?, email: String?) {
        android.util.Log.i("Crash", "setUser: id=$id email=$email")
    }
}

/** No-op for tests. */
class NoopCrashReporter : CrashReporter {
    override fun report(throwable: Throwable, tags: Map<String, String>) {}
    override fun setUser(id: String?, email: String?) {}
}