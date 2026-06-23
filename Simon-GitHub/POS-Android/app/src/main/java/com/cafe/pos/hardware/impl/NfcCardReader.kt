package com.cafe.pos.hardware.impl

import android.app.Activity
import android.content.Context
import android.nfc.NdefRecord
import android.nfc.NfcAdapter
import android.nfc.NfcManager
import android.nfc.Tag
import android.nfc.tech.Ndef
import android.os.Build
import com.cafe.pos.hardware.NfcReader
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import java.nio.charset.Charset

/**
 * NFC reader for loyalty cards (NDEF-formatted) and contactless payment tags.
 *
 * Uses the Android foreground-dispatch pattern: when the [Activity] calls
 * [enable] in onResume, the OS routes any tapped card to our [callback] until
 * [disable] is called in onPause. This is the only reliable way to read NFC
 * while our app is in the foreground, since Android otherwise prefers whichever
 * app is registered for the tag's AID.
 *
 * Supported payload formats (in priority order):
 *   1. NDEF Text record ("partnerId=abc123") — partner loyalty cards
 *   2. NDEF URI ("https://cafe.example/c/abc123")
 *   3. Raw tag ID (fallback) — used for tap-to-pay readers that don't expose NDEF
 */
class NfcCardReader(
    private val context: Context,
) : NfcReader {

    private val nfcManager: NfcManager? =
        context.getSystemService(Context.NFC_SERVICE) as? NfcManager
    private val adapter: NfcAdapter? get() = nfcManager?.defaultAdapter

    private var callback: ((String) -> Unit)? = null

    override fun onCardDetected(callback: (cardId: String) -> Unit) {
        this.callback = callback
    }

    override fun stop() {
        this.callback = null
    }

    /** Returns true if the device has NFC hardware. */
    fun isAvailable(): Boolean = adapter?.isEnabled == true

    /** Call from Activity.onResume. Routes tapped tags to our [callback]. */
    fun enable(activity: Activity) {
        val a = adapter ?: return
        val intent = activity.intent
        // Hot path: an already-tapped card may have arrived in the launching intent.
        intent.getParcelableExtra<Tag>(NfcAdapter.EXTRA_TAG)?.let { onTag(it) }
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
            NfcAdapter.FLAG_READER_NFC_A or NfcAdapter.FLAG_READER_NFC_B or
            NfcAdapter.FLAG_READER_NFC_F or NfcAdapter.FLAG_READER_NFC_V
        else 0
        // Reader-mode + foreground dispatch are mutually exclusive on some OEMs;
        // we use reader-mode (cleaner, no PendingIntent juggling).
        a.enableReaderMode(activity, { tag -> onTag(tag) }, flags, null)
    }

    fun disable(activity: Activity) {
        adapter?.disableReaderMode(activity)
    }

    private fun onTag(tag: Tag) {
        val cb = callback ?: return
        val fromNdef = readNdefText(tag)
        val rawId = tag.id?.joinToString(":") { "%02X".format(it) }
        cb(fromNdef ?: "tag:$rawId")
    }

    private fun readNdefText(tag: Tag): String? {
        val ndef = Ndef.get(tag) ?: return null
        return try {
            ndef.connect()
            val msg = ndef.ndefMessage ?: return null
            for (record in msg.records) {
                // Well-known Text record
                if (record.tnf == NdefRecord.TNF_WELL_KNOWN && record.type[0] == NdefRecord.RTD_TEXT[0]) {
                    val payload = record.payload
                    val status = payload[0].toInt()
                    val langLen = status and 0x3F
                    val text = String(payload, langLen + 1, payload.size - langLen - 1, Charsets.UTF_8)
                    ndef.close()
                    return text
                }
                // URI record
                if (record.tnf == NdefRecord.TNF_WELL_KNOWN && record.type[0] == NdefRecord.RTD_URI[0]) {
                    val payload = record.payload
                    val prefix = URI_PREFIXES.getOrElse(payload[0].toInt()) { "" }
                    val text = prefix + String(payload, 1, payload.size - 1, Charsets.UTF_8)
                    ndef.close()
                    return text
                }
            }
            ndef.close()
            null
        } catch (e: Exception) {
            runCatching { ndef.close() }
            null
        }
    }

    /**
     * Convenience Flow that emits card IDs and completes on [stop]. The UI layer
     * usually prefers [onCardDetected] + [enable], but this is useful for tests
     * and Compose previews.
     */
    fun cardStream(): Flow<String> = callbackFlow {
        onCardDetected { trySend(it) }
        awaitClose { stop() }
    }

    private companion object {
        // RTD_URI prefix table (NFC Forum NDEF spec).
        val URI_PREFIXES = arrayOf(
            "", "http://www.", "https://www.", "http://", "https://",
            "tel:", "mailto:", "ftp://anonymous:anonymous@", "ftp://ftp.",
            "ftps://", "sftp://", "smb://", "nfs://", "ftp://", "dav://",
            "news:", "telnet://", "imap:", "rtsp://", "urn:", "pop:",
            "sip:", "sips:", "tftp:", "btspp://", "btl2cap://", "btgoep://",
            "tcpobex://", "irdaobex://", "file://", "urn:epc:id:",
            "urn:epc:tag:", "urn:epc:pat:", "urn:epc:raw:", "urn:epc:",
            "urn:nfc:",
        )
    }
}