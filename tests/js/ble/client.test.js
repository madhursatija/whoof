// Integration tests for WhoopClient with a mocked BLE backend.
// We don't have a strap in CI, so we fake the Web Bluetooth characteristics
// and drive the historical-dump state machine end-to-end.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WhoopClient } from '../../../web/js/ble/client.js';
import {
  WhoopPacket, PacketType, CommandNumber, MetadataType, EventNumber,
} from '../../../web/js/ble/packet.js';

/** Build a framed METADATA packet for the dump state machine. */
function metaFrame(kind, { unix = 0, trim = 0 } = {}) {
  const data = new Uint8Array(14);
  // bytes 0..4 unix
  data[0] = unix & 0xff;
  data[1] = (unix >> 8) & 0xff;
  data[2] = (unix >> 16) & 0xff;
  data[3] = (unix >> 24) & 0xff;
  // bytes 10..14 trim
  data[10] = trim & 0xff;
  data[11] = (trim >> 8) & 0xff;
  data[12] = (trim >> 16) & 0xff;
  data[13] = (trim >> 24) & 0xff;
  return new WhoopPacket(PacketType.METADATA, 0, kind, data).framed();
}

/** Build a framed HISTORICAL_DATA packet (HR + 1 RR). */
function historicalFrame({ unix = 1716200000, hr = 60, rr = 1000 } = {}) {
  const data = new Uint8Array(32);
  data[4] = unix & 0xff;
  data[5] = (unix >> 8) & 0xff;
  data[6] = (unix >> 16) & 0xff;
  data[7] = (unix >> 24) & 0xff;
  data[14] = hr;
  data[15] = 1;
  data[16] = rr & 0xff;
  data[17] = (rr >> 8) & 0xff;
  return new WhoopPacket(PacketType.HISTORICAL_DATA, 0, 0, data).framed();
}

/** Build a framed EVENT packet. */
function eventFrame(cmd, payload = new Uint8Array([0, 0, 0, 0, 0])) {
  return new WhoopPacket(PacketType.EVENT, 0, cmd, payload).framed();
}

/** Build a framed COMMAND_RESPONSE packet. */
function responseFrame(cmd, payload) {
  return new WhoopPacket(PacketType.COMMAND_RESPONSE, 0, cmd, payload).framed();
}

/** A fake GATT characteristic that records writes + supports notification fire. */
function makeCharacteristic() {
  const listeners = new Set();
  let writes = [];
  return {
    writes,
    listeners,
    writeValue: vi.fn(async (bytes) => { writes.push(bytes); }),
    startNotifications: vi.fn(async () => {}),
    addEventListener: (event, fn) => { if (event === 'characteristicvaluechanged') listeners.add(fn); },
    /** Fire a notification with a Uint8Array — wraps it as DataView like the browser does. */
    fire(bytes) {
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (const fn of listeners) fn({ target: { value: dv } });
    },
  };
}

function makeFakeDevice() {
  const cmd = makeCharacteristic();
  const resp = makeCharacteristic();
  const data = makeCharacteristic();
  const event = makeCharacteristic();
  const service = {
    getCharacteristic: vi.fn(async (uuid) => {
      if (uuid.startsWith('61080002')) return cmd;
      if (uuid.startsWith('61080003')) return resp;
      if (uuid.startsWith('61080004')) return event;
      if (uuid.startsWith('61080005')) return data;
      throw new Error('unknown UUID ' + uuid);
    }),
  };
  const gatt = {
    connected: true,
    connect: vi.fn(async () => ({
      getPrimaryService: vi.fn(async () => service),
      connected: true,
      disconnect: vi.fn(),
    })),
  };
  return {
    id: 'mock-strap',
    gatt,
    addEventListener: vi.fn(),
    _chars: { cmd, resp, data, event },
  };
}

describe('WhoopClient mocked BLE', () => {
  let client, device;

  beforeEach(() => {
    device = makeFakeDevice();
    client = new WhoopClient();
  });

  it('parses realtime sample notifications', async () => {
    await client.connectToDevice(device);
    // We don't await postConnectFlow — it sends async commands; we just
    // verify the sample handler works.
    const samples = [];
    client.on('sample', (s) => samples.push(s));

    // Build a realtime data packet: HR=72 at data[5], rrnum=1, rr=850 at data[7..9]
    const payload = new Uint8Array(32);
    payload[5] = 72;
    payload[6] = 1;
    payload[7] = 850 & 0xff;
    payload[8] = (850 >> 8) & 0xff;
    const realtime = new WhoopPacket(PacketType.REALTIME_DATA, 0, 0, payload).framed();
    device._chars.data.fire(realtime);

    expect(samples).toHaveLength(1);
    expect(samples[0].heartRateBpm).toBe(72);
    expect(samples[0].rrIntervalsMs).toEqual([850]);
  });

  it('runs the historical-dump state machine to completion', async () => {
    await client.connectToDevice(device);

    const historicalSamples = [];
    const progressEvents = [];
    client.on('historicalSample', (s) => historicalSamples.push(s));
    client.on('historyProgress', (e) => progressEvents.push(e));

    // Drain initial commands the post-connect flow has already queued — we
    // only care about commands AFTER downloadHistory() is invoked.
    const writesBefore = device._chars.cmd.writes.length;

    // Start dump in parallel with the simulator below
    const dumpPromise = client.downloadHistory();

    // The strap simulator: send START, three samples, END (trim=42), then
    // wait for our ACK, then send another END (trim=99), then COMPLETE.
    queueMicrotask(async () => {
      device._chars.data.fire(metaFrame(MetadataType.HISTORY_START, { unix: 1, trim: 0 }));
      device._chars.data.fire(historicalFrame({ unix: 100, hr: 60, rr: 1000 }));
      device._chars.data.fire(historicalFrame({ unix: 101, hr: 61, rr: 990 }));
      device._chars.data.fire(historicalFrame({ unix: 102, hr: 62, rr: 980 }));
      device._chars.data.fire(metaFrame(MetadataType.HISTORY_END, { unix: 102, trim: 42 }));

      // Yield so the client can process and send its ACK.
      await new Promise(r => setTimeout(r, 0));

      // Second batch + COMPLETE
      device._chars.data.fire(historicalFrame({ unix: 200, hr: 70 }));
      device._chars.data.fire(metaFrame(MetadataType.HISTORY_COMPLETE));
    });

    const result = await dumpPromise;
    expect(result.samples).toBe(4);
    expect(historicalSamples).toHaveLength(4);
    expect(historicalSamples[0].heartRateBpm).toBe(60);
    expect(historicalSamples[0].rrIntervalsMs).toEqual([1000]);

    // Verify we sent SEND_HISTORICAL_DATA + HISTORICAL_DATA_RESULT(trim=42)
    const writesAfter = device._chars.cmd.writes.slice(writesBefore);
    // The actual commands written, parsed back into WhoopPackets:
    const parsedCommands = writesAfter.map(w => WhoopPacket.fromData(w));
    const cmdNums = parsedCommands.map(p => p.cmd);
    expect(cmdNums).toContain(CommandNumber.SEND_HISTORICAL_DATA);
    expect(cmdNums).toContain(CommandNumber.HISTORICAL_DATA_RESULT);

    // The ACK payload should encode trim=42
    const ackPkt = parsedCommands.find(p => p.cmd === CommandNumber.HISTORICAL_DATA_RESULT);
    expect(ackPkt).toBeDefined();
    const trim = ackPkt.data[1] | (ackPkt.data[2] << 8) | (ackPkt.data[3] << 16) | (ackPkt.data[4] << 24);
    expect(trim).toBe(42);
    expect(ackPkt.data[0]).toBe(0x01);

    // historyProgress fires once per ACKed batch
    expect(progressEvents.length).toBeGreaterThanOrEqual(1);
    expect(progressEvents[0].trim).toBe(42);
  });

  it('returns early if a dump is already in flight', async () => {
    await client.connectToDevice(device);
    // Mark in-flight without actually running one
    client._historicalDumpInFlight = true;
    const result = await client.downloadHistory();
    expect(result.alreadyRunning).toBe(true);
  });

  it('decodes WRIST_ON event and updates isWorn', async () => {
    await client.connectToDevice(device);
    const events = [];
    client.on('event', (e) => events.push(e));

    device._chars.event.fire(eventFrame(EventNumber.WRIST_ON));
    expect(client.isWorn).toBe(true);
    expect(events[events.length - 1].semantic).toBe('wristOn');

    device._chars.event.fire(eventFrame(EventNumber.WRIST_OFF));
    expect(client.isWorn).toBe(false);
  });

  it('caches battery from response packet', async () => {
    await client.connectToDevice(device);
    // u16 LE at offset 2 = 857 → 85.7%
    const payload = new Uint8Array([0, 0, 857 & 0xff, (857 >> 8) & 0xff]);
    device._chars.resp.fire(responseFrame(CommandNumber.GET_BATTERY_LEVEL, payload));
    expect(client.batteryPct).toBeCloseTo(85.7, 1);
  });

  it('caches strap state from GET_HELLO_HARVARD response', async () => {
    await client.connectToDevice(device);
    const payload = new Uint8Array(130);
    payload[7] = 1;     // charging
    payload[116] = 1;   // worn
    device._chars.resp.fire(responseFrame(CommandNumber.GET_HELLO_HARVARD, payload));
    expect(client.charging).toBe(true);
    expect(client.isWorn).toBe(true);
  });

  it('reacts to HIGH_FREQ_SYNC_PROMPT by kicking off downloadHistory', async () => {
    await client.connectToDevice(device);
    const spy = vi.spyOn(client, 'downloadHistory').mockResolvedValue({ samples: 0 });
    device._chars.event.fire(eventFrame(EventNumber.HIGH_FREQ_SYNC_PROMPT));
    expect(spy).toHaveBeenCalled();
  });

  it('reacts to RTC_LOST by calling setClock', async () => {
    await client.connectToDevice(device);
    const spy = vi.spyOn(client, 'setClock').mockResolvedValue();
    device._chars.event.fire(eventFrame(EventNumber.RTC_LOST));
    expect(spy).toHaveBeenCalled();
  });

  it('emits historyError if disconnected mid-dump', async () => {
    await client.connectToDevice(device);
    const errors = [];
    client.on('historyError', (e) => errors.push(e));
    // Pretend a dump is mid-flight
    client._historicalDumpInFlight = true;
    client._onDisconnected();
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/disconnect/);
    expect(client._historicalDumpInFlight).toBe(false);
  });

  describe('command helpers send the right cmd byte', () => {
    let cmdNumbersSent;

    beforeEach(async () => {
      await client.connectToDevice(device);
      cmdNumbersSent = () => device._chars.cmd.writes.map(w => WhoopPacket.fromData(w).cmd);
    });

    it('toggleGenericHrProfile sends cmd 14', async () => {
      const before = cmdNumbersSent().length;
      await client.toggleGenericHrProfile(true);
      expect(cmdNumbersSent().slice(before)).toContain(CommandNumber.TOGGLE_GENERIC_HR_PROFILE);
      expect(client._genericHrEnabled).toBe(true);
      await client.toggleGenericHrProfile(false);
      expect(client._genericHrEnabled).toBe(false);
    });

    it('setAlarm encodes unix u32 LE', async () => {
      const t = 1750000000;
      const before = cmdNumbersSent().length;
      await client.setAlarm(t);
      const writes = device._chars.cmd.writes.slice(before);
      const pkt = WhoopPacket.fromData(writes[writes.length - 1]);
      expect(pkt.cmd).toBe(CommandNumber.SET_ALARM_TIME);
      const encoded = pkt.data[0] | (pkt.data[1] << 8) | (pkt.data[2] << 16) | (pkt.data[3] << 24);
      expect(encoded >>> 0).toBe(t);
    });

    it('setAlarm rejects invalid times', async () => {
      await expect(client.setAlarm(0)).rejects.toThrow();
      await expect(client.setAlarm(NaN)).rejects.toThrow();
      await expect(client.setAlarm(-1)).rejects.toThrow();
    });

    it('runAlarmNow, disableAlarm, getExtendedBatteryInfo send right cmds', async () => {
      const before = cmdNumbersSent().length;
      await client.runAlarmNow();
      await client.disableAlarm();
      await client.getExtendedBatteryInfo();
      const sent = cmdNumbersSent().slice(before);
      expect(sent).toEqual([
        CommandNumber.RUN_ALARM,
        CommandNumber.DISABLE_ALARM,
        CommandNumber.GET_EXTENDED_BATTERY_INFO,
      ]);
    });

    it('selectWrist maps left/right to 0/1', async () => {
      const before = cmdNumbersSent().length;
      await client.selectWrist('left');
      await client.selectWrist('right');
      const writes = device._chars.cmd.writes.slice(before);
      const left = WhoopPacket.fromData(writes[0]);
      const right = WhoopPacket.fromData(writes[1]);
      expect(left.cmd).toBe(CommandNumber.SELECT_WRIST);
      expect(left.data[0]).toBe(0);
      expect(right.data[0]).toBe(1);
    });

    it('enterHighFreqSync + exitHighFreqSync', async () => {
      const before = cmdNumbersSent().length;
      await client.enterHighFreqSync();
      await client.exitHighFreqSync();
      const sent = cmdNumbersSent().slice(before);
      expect(sent).toEqual([CommandNumber.ENTER_HIGH_FREQ_SYNC, CommandNumber.EXIT_HIGH_FREQ_SYNC]);
    });
  });
});
