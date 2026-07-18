package com.poscafe.pos.printing

import java.io.ByteArrayOutputStream

/**
 * Minimal ESC/POS builder for 80mm printers (48 columns at Font A) — a Kotlin
 * port of the server's shared ticket frame (pos-receipts.service.ts). Text is
 * encoded CP437-ish (ASCII subset; non-ASCII folded) so cheap thermal
 * printers render it correctly.
 */
class EscPos(private val cols: Int = 48) {
    private val buf = ByteArrayOutputStream()

    fun init(): EscPos = raw(0x1B, 0x40)
    fun cut(): EscPos = feed(4).raw(0x1D, 0x56, 0x00)
    fun feed(lines: Int = 1): EscPos = apply { repeat(lines) { text("\n") } }
    fun bold(on: Boolean): EscPos = raw(0x1B, 0x45, if (on) 1 else 0)
    fun doubleSize(on: Boolean): EscPos = raw(0x1D, 0x21, if (on) 0x11 else 0x00)
    fun alignCenter(): EscPos = raw(0x1B, 0x61, 1)
    fun alignLeft(): EscPos = raw(0x1B, 0x61, 0)
    fun openDrawer(): EscPos = raw(0x1B, 0x70, 0x00, 0x19, 0xFA)

    fun line(s: String = ""): EscPos = text(s.take(cols) + "\n")
    fun rule(ch: Char = '-'): EscPos = line(ch.toString().repeat(cols))

    fun center(s: String): EscPos {
        val trimmed = s.take(cols)
        val pad = ((cols - trimmed.length) / 2).coerceAtLeast(0)
        return line(" ".repeat(pad) + trimmed)
    }

    /** Left/right column pair padded to the full width. */
    fun pair(left: String, right: String): EscPos {
        val r = right.take(cols)
        val l = left.take((cols - r.length - 1).coerceAtLeast(0))
        val pad = (cols - l.length - r.length).coerceAtLeast(1)
        return line(l + " ".repeat(pad) + r)
    }

    /** Qty x Name .... amount line with wrap for long names. */
    fun item(qty: String, name: String, amount: String): EscPos {
        val prefix = "$qty x "
        val amountCol = amount.padStart(10)
        val nameWidth = cols - prefix.length - amountCol.length
        val first = name.take(nameWidth)
        line(prefix + first.padEnd(nameWidth) + amountCol)
        var rest = name.drop(nameWidth)
        while (rest.isNotEmpty()) {
            line(" ".repeat(prefix.length) + rest.take(cols - prefix.length))
            rest = rest.drop(cols - prefix.length)
        }
        return this
    }

    fun text(s: String): EscPos = apply {
        // Fold to printable ASCII; cheap CP437 printers garble the rest.
        val folded = s.map { c -> if (c.code in 32..126 || c == '\n') c else '?' }.joinToString("")
        buf.write(folded.toByteArray(Charsets.US_ASCII))
    }

    fun raw(vararg bytes: Int): EscPos = apply { bytes.forEach { buf.write(it) } }

    fun bytes(): ByteArray = buf.toByteArray()
}
