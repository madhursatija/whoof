import { describe, it, expect } from 'vitest';
import {
  WhoopPacket, PacketType, CommandNumber, EventNumber, MetadataType,
  buildCommandFrame, SOF,
} from '../../../web/js/ble/packet.js';
import { crc32Whoop, crc8 } from '../../../web/js/ble/crc.js';

function buildFrame(type, seq, cmd, payload = new Uint8Array()) {
  return new WhoopPacket(type, seq, cmd, payload).framed();
}

describe('WhoopPacket framing', () => {
  it('round-trips through framed() + fromData()', () => {
    const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const pkt = new WhoopPacket(PacketType.COMMAND, 7, CommandNumber.GET_BATTERY_LEVEL, payload);
    const frame = pkt.framed();

    expect(frame[0]).toBe(SOF);
    const parsed = WhoopPacket.fromData(frame);
    expect(parsed.type).toBe(PacketType.COMMAND);
    expect(parsed.seq).toBe(7);
    expect(parsed.cmd).toBe(CommandNumber.GET_BATTERY_LEVEL);
    expect(Array.from(parsed.data)).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it('length field is little-endian body_len + 4', () => {
    const frame = buildFrame(PacketType.COMMAND, 0, CommandNumber.TOGGLE_REALTIME_HR, new Uint8Array([0x01]));
    // body = type+seq+cmd+payload = 4 bytes; len = 4 + 4(crc32) = 8
    expect(frame[1]).toBe(0x08);
    expect(frame[2]).toBe(0x00);
  });

  it('crc8 of length bytes matches', () => {
    const frame = buildFrame(PacketType.COMMAND, 0, CommandNumber.TOGGLE_REALTIME_HR, new Uint8Array([0x01]));
    expect(frame[3]).toBe(crc8(new Uint8Array([frame[1], frame[2]])));
  });

  it('trailing crc32 matches over body', () => {
    const frame = buildFrame(PacketType.COMMAND, 0, CommandNumber.TOGGLE_REALTIME_HR, new Uint8Array([0x01]));
    const length = frame[1] | (frame[2] << 8);
    const body = frame.slice(4, length);
    const crc = frame[length] | (frame[length + 1] << 8) |
                (frame[length + 2] << 16) | (frame[length + 3] << 24);
    expect(crc >>> 0).toBe(crc32Whoop(body));
  });

  it('rejects bad SOF', () => {
    const frame = buildFrame(PacketType.COMMAND, 0, CommandNumber.TOGGLE_REALTIME_HR);
    frame[0] = 0xff;
    expect(() => WhoopPacket.fromData(frame)).toThrow(/SOF/);
  });

  it('rejects bad crc8', () => {
    const frame = buildFrame(PacketType.COMMAND, 0, CommandNumber.TOGGLE_REALTIME_HR, new Uint8Array([0x01]));
    frame[3] ^= 0xff;
    expect(() => WhoopPacket.fromData(frame)).toThrow(/CRC-8/);
  });

  it('rejects bad crc32', () => {
    const frame = buildFrame(PacketType.COMMAND, 0, CommandNumber.TOGGLE_REALTIME_HR, new Uint8Array([0x01]));
    frame[frame.length - 1] ^= 0xff;
    expect(() => WhoopPacket.fromData(frame)).toThrow(/CRC-32/);
  });

  it('rejects too-short frames', () => {
    expect(() => WhoopPacket.fromData(new Uint8Array([0xaa, 0, 0]))).toThrow();
  });
});

describe('buildCommandFrame helper', () => {
  it('is equivalent to constructing a COMMAND packet', () => {
    const a = buildCommandFrame(CommandNumber.GET_BATTERY_LEVEL, new Uint8Array([0x00]), 5);
    const b = new WhoopPacket(PacketType.COMMAND, 5, CommandNumber.GET_BATTERY_LEVEL, new Uint8Array([0x00])).framed();
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});

describe('protocol enums', () => {
  it('PacketType matches canonical values', () => {
    expect(PacketType.COMMAND).toBe(35);
    expect(PacketType.REALTIME_DATA).toBe(40);
    expect(PacketType.HISTORICAL_DATA).toBe(47);
    expect(PacketType.EVENT).toBe(48);
    expect(PacketType.METADATA).toBe(49);
  });

  it('MetadataType matches canonical values', () => {
    expect(MetadataType.HISTORY_START).toBe(1);
    expect(MetadataType.HISTORY_END).toBe(2);
    expect(MetadataType.HISTORY_COMPLETE).toBe(3);
  });

  it('CommandNumber covers the critical commands', () => {
    expect(CommandNumber.TOGGLE_REALTIME_HR).toBe(3);
    expect(CommandNumber.GET_BATTERY_LEVEL).toBe(26);
    expect(CommandNumber.SEND_HISTORICAL_DATA).toBe(22);
    expect(CommandNumber.HISTORICAL_DATA_RESULT).toBe(23);
    expect(CommandNumber.GET_DATA_RANGE).toBe(34);
    expect(CommandNumber.SET_CLOCK).toBe(10);
    expect(CommandNumber.GET_CLOCK).toBe(11);
    expect(CommandNumber.GET_HELLO_HARVARD).toBe(35);
    expect(CommandNumber.ENTER_HIGH_FREQ_SYNC).toBe(96);
  });

  it('EventNumber covers events we wire to the UI', () => {
    expect(EventNumber.WRIST_ON).toBe(9);
    expect(EventNumber.WRIST_OFF).toBe(10);
    expect(EventNumber.CHARGING_ON).toBe(7);
    expect(EventNumber.CHARGING_OFF).toBe(8);
    expect(EventNumber.DOUBLE_TAP).toBe(14);
    expect(EventNumber.RTC_LOST).toBe(13);
    expect(EventNumber.HIGH_FREQ_SYNC_PROMPT).toBe(96);
  });
});
