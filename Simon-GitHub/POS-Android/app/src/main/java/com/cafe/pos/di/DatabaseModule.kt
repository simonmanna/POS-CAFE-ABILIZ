package com.cafe.pos.di

import android.content.Context
import androidx.room.Room
import com.cafe.pos.data.local.CafePosDatabase
import com.cafe.pos.data.local.CatalogDao
import com.cafe.pos.data.local.PendingSaleDao
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object DatabaseModule {

    @Provides @Singleton
    fun provideDatabase(@ApplicationContext context: Context): CafePosDatabase =
        Room.databaseBuilder(context, CafePosDatabase::class.java, "cafe-pos.db")
            .addMigrations(CafePosDatabase.MIGRATION_1_2)
            .fallbackToDestructiveMigration()
            .build()

    @Provides @Singleton
    fun provideCatalogDao(db: CafePosDatabase): CatalogDao = db.catalogDao()

    @Provides @Singleton
    fun providePendingSaleDao(db: CafePosDatabase): PendingSaleDao = db.pendingSaleDao()
}