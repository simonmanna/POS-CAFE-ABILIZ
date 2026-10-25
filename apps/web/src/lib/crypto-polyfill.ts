/**
 * `crypto.randomUUID` only exists in secure contexts (https or localhost). A
 * till opened over plain http — a LAN terminal on http://<ip>:5173, or a demo
 * served by IP — has `crypto.getRandomValues` but no `randomUUID`, and the POS
 * mints line ids and idempotency keys with it. Provide an RFC 4122 v4
 * equivalent there; a real implementation is never replaced.
 */
if (typeof crypto !== 'undefined' && typeof crypto.randomUUID !== 'function') {
  crypto.randomUUID = () => {
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0'));
    return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10).join('')}` as ReturnType<Crypto['randomUUID']>;
  };
}

export {};
