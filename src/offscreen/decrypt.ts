// AES-128 decryption for HLS (RFC 8216 §5.2). Method AES-128 = AES-128-CBC with
// PKCS7 padding. IV is either the explicit #EXT-X-KEY IV attribute, or — when
// absent — the segment's media sequence number as a 16-byte big-endian value.

function hexToBytes(hex: string): Uint8Array {
  let h = hex.trim();
  if (h.startsWith('0x') || h.startsWith('0X')) h = h.slice(2);
  if (h.length % 2 !== 0) h = '0' + h;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.substr(i * 2, 2), 16);
  }
  return out;
}

export function ivForSequence(seq: number): Uint8Array {
  const iv = new Uint8Array(16);
  // Big-endian; sequence fits in the low 32 bits for any realistic stream.
  const view = new DataView(iv.buffer);
  view.setUint32(12, seq >>> 0, false);
  return iv;
}

export function parseIv(ivAttr: string | undefined, seq: number): Uint8Array {
  if (ivAttr) {
    const bytes = hexToBytes(ivAttr);
    if (bytes.length === 16) return bytes;
  }
  return ivForSequence(seq);
}

export async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-CBC' }, false, [
    'decrypt',
  ]);
}

export async function decryptSegment(
  key: CryptoKey,
  iv: Uint8Array,
  data: Uint8Array,
): Promise<Uint8Array> {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv: iv as BufferSource },
    key,
    data as BufferSource,
  );
  return new Uint8Array(plain);
}
