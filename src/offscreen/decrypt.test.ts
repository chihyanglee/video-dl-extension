import { describe, it, expect } from 'vitest';
import { ivForSequence, parseIv, importAesKey, decryptSegment } from './decrypt';

describe('ivForSequence', () => {
  it('returns 16 zero bytes for sequence 0', () => {
    const iv = ivForSequence(0);
    expect(iv).toHaveLength(16);
    expect([...iv].every((b) => b === 0)).toBe(true);
  });

  it('encodes the sequence big-endian in the low bytes', () => {
    const iv = ivForSequence(1);
    expect(iv[15]).toBe(1);
    expect([...iv.slice(0, 15)].every((b) => b === 0)).toBe(true);
  });
});

describe('parseIv', () => {
  it('parses an explicit hex IV', () => {
    const iv = parseIv('0x000102030405060708090a0b0c0d0e0f', 0);
    expect(iv).toHaveLength(16);
    expect([...iv]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });

  it('falls back to ivForSequence when IV is missing', () => {
    const iv = parseIv(undefined, 5);
    expect([...iv]).toEqual([...ivForSequence(5)]);
  });
});

describe('decryptSegment', () => {
  it('round-trips an AES-128-CBC encrypted payload', async () => {
    const keyBytes = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(16));
    const plaintext = new TextEncoder().encode('hello aes-128-cbc segment payload');

    const encKey = await crypto.subtle.importKey(
      'raw',
      keyBytes,
      { name: 'AES-CBC' },
      false,
      ['encrypt'],
    );
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, encKey, plaintext),
    );

    const decKey = await importAesKey(keyBytes);
    const decrypted = await decryptSegment(decKey, iv, ciphertext);
    expect([...decrypted]).toEqual([...plaintext]);
  });
});
