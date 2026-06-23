package com.cafe.pos.di

import com.cafe.pos.BuildConfig
import com.cafe.pos.data.api.AuthApi
import com.cafe.pos.data.api.AuthInterceptor
import com.cafe.pos.data.api.CashSessionApi
import com.cafe.pos.data.api.CatalogApi
import com.cafe.pos.data.api.PosApi
import com.cafe.pos.data.model.LoginResponse
import com.cafe.pos.data.model.RefreshRequest
import com.cafe.pos.data.api.TokenAuthenticator
import com.squareup.moshi.Moshi
import com.squareup.moshi.kotlin.reflect.KotlinJsonAdapterFactory
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.moshi.MoshiConverterFactory
import retrofit2.http.Body
import retrofit2.http.POST
import java.util.concurrent.TimeUnit
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object NetworkModule {

    @Provides @Singleton
    fun provideMoshi(): Moshi = Moshi.Builder()
        .add(KotlinJsonAdapterFactory())
        .build()

    @Provides @Singleton
    fun provideLoggingInterceptor(): HttpLoggingInterceptor =
        HttpLoggingInterceptor().apply {
            level = if (BuildConfig.DEBUG) HttpLoggingInterceptor.Level.BODY
                    else HttpLoggingInterceptor.Level.BASIC
        }

    @Provides @Singleton
    fun provideOkHttp(
        authInterceptor: AuthInterceptor,
        tokenAuthenticator: TokenAuthenticator,
        logging: HttpLoggingInterceptor,
    ): OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .addInterceptor(authInterceptor)
        .authenticator(tokenAuthenticator)
        .addInterceptor(logging)
        .retryOnConnectionFailure(true)
        .build()

    @Provides @Singleton
    fun provideRetrofit(client: OkHttpClient, moshi: Moshi): Retrofit =
        Retrofit.Builder()
            .baseUrl(BuildConfig.API_BASE_URL)
            .client(client)
            .addConverterFactory(MoshiConverterFactory.create(moshi))
            .build()

    @Provides @Singleton
    fun provideAuthApi(retrofit: Retrofit): AuthApi = retrofit.create(AuthApi::class.java)

    @Provides @Singleton
    fun provideCatalogApi(retrofit: Retrofit): CatalogApi = retrofit.create(CatalogApi::class.java)

    @Provides @Singleton
    fun providePosApi(retrofit: Retrofit): PosApi = retrofit.create(PosApi::class.java)

    @Provides @Singleton
    fun provideCashSessionApi(retrofit: Retrofit): CashSessionApi =
        retrofit.create(CashSessionApi::class.java)

    /**
     * Bare unauthenticated Retrofit used *only* by [TokenAuthenticator] to mint a fresh
     * access token. Uses a separate OkHttp client without auth so /auth/refresh
     * can't recursively trigger itself.
     *
     * Hilt auto-generates a `Provider<RefreshApi>` binding from this @Provides
     * so [TokenAuthenticator] can lazily resolve it without the cycle.
     */
    @Provides @Singleton
    fun provideRefreshApi(logging: HttpLoggingInterceptor, moshi: Moshi): RefreshApi {
        val plain = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .addInterceptor(logging)
            .build()
        val retrofit = Retrofit.Builder()
            .baseUrl(BuildConfig.API_BASE_URL)
            .client(plain)
            .addConverterFactory(MoshiConverterFactory.create(moshi))
            .build()
        return retrofit.create(RefreshApi::class.java)
    }
}

interface RefreshApi {
    @POST("auth/refresh")
    suspend fun refresh(@Body body: RefreshRequest): LoginResponse
}