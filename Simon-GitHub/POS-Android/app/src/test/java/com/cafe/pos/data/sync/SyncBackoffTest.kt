package com.cafe.pos.data.sync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Verifies the backoff schedule matches the design doc.
 * If you change the policy, update the test in lockstep.
 */
class SyncBackoffTest {

    @Test fun `attempts under the cap are not dead`() {
        for (i in 0 until SyncBackoff.MAX_ATTEMPTS) {
            assertTrue("attempt $i should not be dead", !SyncBackoff.isDead(i))
        }
    }

    @Test fun `attempts at the cap are dead`() {
        assertTrue(SyncBackoff.isDead(SyncBackoff.MAX_ATTEMPTS))
        assertTrue(SyncBackoff.isDead(SyncBackoff.MAX_ATTEMPTS + 1))
    }

    @Test fun `delay grows exponentially up to the 2min cap`() {
        val delays = (0..6).map { SyncBackoff.delayMs(it) }
        // 1s, 2s, 4s, 8s, 16s, 32s, 64s — strictly increasing until the cap.
        for (i in 1 until delays.size) {
            assertTrue(
                "delay $i (${delays[i]}) must exceed delay ${i-1} (${delays[i-1]})",
                delays[i] > delays[i - 1],
            )
        }
    }

    @Test fun `delay is capped at 128s for high attempt counts`() {
        // Even at attempt 100 the delay is bounded — the dead-letter
        // threshold (8) is what stops the worker, not the delay cap.
        assertEquals(128_000L, SyncBackoff.delayMs(7))
        assertEquals(128_000L, SyncBackoff.delayMs(8))
        assertEquals(128_000L, SyncBackoff.delayMs(100))
    }

    @Test fun `nextAttemptAt is in the future`() {
        val now = 1_000_000_000L
        val next = SyncBackoff.nextAttemptAt(2, now)
        assertTrue(next > now)
    }
}