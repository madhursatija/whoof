import { describe, it, expect } from 'vitest';
import { crc32Whoop, crc8, verifyCrc } from '../../../web/js/ble/crc.js';

describe('crc32Whoop', () => {
  it('matches the empty-input known value', () => {
    expect(crc32Whoop(new Uint8Array())).toBe(0);
  });

  it('returns a uint32 for a non-empty buffer', () => {
    const data = new Uint8Array([35, 0, 7, 0]);
    const crc = crc32Whoop(data);
    expect(crc).toBe(0xdc82490b);
  });

  it('verifyCrc returns true for matching CRC', () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    expect(verifyCrc(data, crc32Whoop(data))).toBe(true);
  });

  it('verifyCrc returns false for non-matching CRC', () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    expect(verifyCrc(data, 0xdeadbeef)).toBe(false);
  });
});

describe('crc8', () => {
  it('computes correct crc8 for length bytes', () => {
    const lenBuf = new Uint8Array([0x08, 0x00]);
    expect(crc8(lenBuf)).toBe(0xa8);
  });
});
