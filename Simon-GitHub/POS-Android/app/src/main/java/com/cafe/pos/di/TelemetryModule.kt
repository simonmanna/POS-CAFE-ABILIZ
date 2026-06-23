package com.cafe.pos.di

import com.cafe.pos.telemetry.ConsoleCrashReporter
import com.cafe.pos.telemetry.CrashReporter
import dagger.Binds
import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

/**
 * Telemetry bindings. To wire a real crash backend (Sentry, Firebase,
 * Bugsnag) replace [ConsoleCrashReporter] with an adapter implementation
 * and rebind here.
 */
@Module
@InstallIn(SingletonComponent::class)
abstract class TelemetryModule {

    @Binds
    @Singleton
    abstract fun bindCrashReporter(impl: ConsoleCrashReporter): CrashReporter
}