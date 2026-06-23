package com.cafe.pos.di

import android.content.Context
import com.cafe.pos.hardware.BarcodeScanner
import com.cafe.pos.hardware.CashDrawer
import com.cafe.pos.hardware.HardwareServices
import com.cafe.pos.hardware.NfcReader
import com.cafe.pos.hardware.PrinterManager
import com.cafe.pos.hardware.impl.BluetoothEscPosPrinter
import com.cafe.pos.hardware.impl.CameraBarcodeScanner
import com.cafe.pos.hardware.impl.CompositePrinterManager
import com.cafe.pos.hardware.impl.EscPosCashDrawer
import com.cafe.pos.hardware.impl.NetworkEscPosPrinter
import com.cafe.pos.hardware.impl.NfcCardReader
import com.cafe.pos.hardware.impl.UsbEscPosPrinter
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

/**
 * Real hardware bindings. Each driver is instantiated with the application
 * context; the [CompositePrinterManager] merges USB, Bluetooth, and Network
 * transports and persists the last-used device via [com.cafe.pos.hardware.PrinterPreferences].
 */
@Module
@InstallIn(SingletonComponent::class)
object HardwareModule {

    @Provides @Singleton
    fun provideUsbPrinter(@ApplicationContext ctx: Context): UsbEscPosPrinter =
        UsbEscPosPrinter(ctx)

    @Provides @Singleton
    fun provideBluetoothPrinter(@ApplicationContext ctx: Context): BluetoothEscPosPrinter =
        BluetoothEscPosPrinter(ctx)

    @Provides @Singleton
    fun provideNetworkPrinter(): NetworkEscPosPrinter = NetworkEscPosPrinter()

    @Provides @Singleton
    fun provideCompositePrinter(
        usb: UsbEscPosPrinter,
        bluetooth: BluetoothEscPosPrinter,
        network: NetworkEscPosPrinter,
        preferences: com.cafe.pos.hardware.PrinterPreferences,
    ): CompositePrinterManager = CompositePrinterManager(usb, bluetooth, network, preferences)

    @Provides @Singleton
    fun providePrinterManager(composite: CompositePrinterManager): PrinterManager = composite

    @Provides @Singleton
    fun provideScanner(@ApplicationContext ctx: Context): BarcodeScanner =
        CameraBarcodeScanner(ctx)

    @Provides @Singleton
    fun provideCameraBarcodeScanner(@ApplicationContext ctx: Context): CameraBarcodeScanner =
        CameraBarcodeScanner(ctx)

    @Provides @Singleton
    fun provideNfcReader(@ApplicationContext ctx: Context): NfcReader =
        NfcCardReader(ctx)

    @Provides @Singleton
    fun provideNfcCardReader(@ApplicationContext ctx: Context): NfcCardReader =
        NfcCardReader(ctx)

    @Provides @Singleton
    fun provideCashDrawer(printer: PrinterManager): CashDrawer = EscPosCashDrawer(printer)

    @Provides @Singleton
    fun provideHardwareServices(
        printer: PrinterManager,
        scanner: BarcodeScanner,
        cashDrawer: CashDrawer,
        nfc: NfcReader,
    ): HardwareServices = HardwareServices(printer, scanner, cashDrawer, nfc)
}