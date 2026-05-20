// Web Bluetooth client for Whoop 4.0.
//
// On connect:
//   1. open GATT + subscribe to RESPONSE / DATA / EVENT chars
//   2. GET_HELLO_HARVARD → learn charging + wrist-worn + serial
//   3. SET_CLOCK if the strap's RTC drifted (or RTC_LOST fires later)
//   4. SEND_HISTORICAL_DATA → drain the strap's flash buffer (backfill)
//   5. TOGGLE_REALTIME_HR(0x01) → start the realtime sample stream
//
// On HIGH_FREQ_SYNC_PROMPT event (strap flash filling up), kick off another
// historical dump.
//
// Auto-reconnects with exponential backoff on `gattserverdisconnected`.

import {
  SERVICE_UUID, CHAR_COMMAND_UUID, CHAR_RESPONSE_UUID,
  CHAR_DATA_UUID, CHAR_EVENT_UUID,
} from './uuids.js';
import {
  WhoopPacket, PacketType, CommandNumber, EventNumber, MetadataType,
  buildCommandFrame,
} from './packet.js';
import {
  decodePacket, parseBatteryResponse, parseClockResponse,
  parseHelloResponse, parseHistorical,
} from './parsers.js';
import { createEmitter } from '../util/events.js';

const RECONNECT_INITIAL_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const BATTERY_POLL_MS = 60000;
const RTC_DRIFT_THRESHOLD_S = 5;
const META_QUEUE_TIMEOUT_MS = 30000;

/**
 * Tiny async queue used to feed METADATA packets from the data-channel
 * notification handler into the historical-dump coroutine.
 */
class AsyncQueue {
  constructor() { this._items = []; this._waiters = []; }
  push(x) {
    if (this._waiters.length) {
      const [resolve] = this._waiters.shift();
      resolve(x);
    } else {
      this._items.push(x);
    }
  }
  async pop(timeoutMs) {
    if (this._items.length) return this._items.shift();
    return new Promise((resolve, reject) => {
      const entry = [resolve];
      this._waiters.push(entry);
      if (timeoutMs) {
        setTimeout(() => {
          const i = this._waiters.indexOf(entry);
          if (i >= 0) { this._waiters.splice(i, 1); reject(new Error('queue timeout')); }
        }, timeoutMs);
      }
    });
  }
  clear() { this._items.length = 0; }
}

export class WhoopClient {
  constructor() {
    this._emitter = createEmitter();
    this.device = null;
    this.server = null;
    this.charCmd = null;
    this.charResp = null;
    this.charData = null;
    this.charEvent = null;
    this.connected = false;
    this._reconnectBackoff = RECONNECT_INITIAL_MS;
    this._intentionalDisconnect = false;
    this._seq = 0;
    this._batteryPollInterval = null;
    this._metaQueue = new AsyncQueue();
    this._historicalDumpInFlight = false;
    this._state = 'disconnected';

    // Cached strap state surfaced to the UI:
    this.charging = null;
    this.isWorn = null;
    this.serial = null;
    this.batteryPct = null;
    this.lastClockUnix = null;
  }

  // ----- event emitter ----------------------------------------------------

  on(event, fn) { return this._emitter.on(event, fn); }
  _emit(event, payload) { this._emitter.emit(event, payload); }
  _setState(s) { this._state = s; this._emit('state', s); }

  // ----- connection lifecycle ---------------------------------------------

  async requestAndConnect() {
    this._intentionalDisconnect = false;
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [SERVICE_UUID] }, { namePrefix: 'WHOOP' }],
      optionalServices: [SERVICE_UUID],
    });
    this.device.addEventListener('gattserverdisconnected', () => this._onDisconnected());
    await this._connect();
  }

  async connectToDevice(device) {
    this._intentionalDisconnect = false;
    this.device = device;
    this.device.addEventListener('gattserverdisconnected', () => this._onDisconnected());
    await this._connect();
  }

  async _connect() {
    this._setState('connecting');
    this.server = await this.device.gatt.connect();
    const service = await this.server.getPrimaryService(SERVICE_UUID);
    this.charCmd   = await service.getCharacteristic(CHAR_COMMAND_UUID);
    this.charResp  = await service.getCharacteristic(CHAR_RESPONSE_UUID);
    this.charData  = await service.getCharacteristic(CHAR_DATA_UUID);
    this.charEvent = await service.getCharacteristic(CHAR_EVENT_UUID);

    this.charData.addEventListener('characteristicvaluechanged', (e) => this._onData(e));
    await this.charData.startNotifications();

    this.charResp.addEventListener('characteristicvaluechanged', (e) => this._onResponse(e));
    await this.charResp.startNotifications();

    this.charEvent.addEventListener('characteristicvaluechanged', (e) => this._onEvent(e));
    await this.charEvent.startNotifications();

    this.connected = true;
    this._reconnectBackoff = RECONNECT_INITIAL_MS;
    this._setState('connected');

    // Kick off the post-connect flow without blocking the caller.
    this._postConnectFlow().catch((err) => this._emit('error', err));

    // Battery poller
    this._batteryPollInterval = setInterval(() => this.getBatteryLevel(), BATTERY_POLL_MS);
  }

  async _postConnectFlow() {
    // 1. Strap identity / status
    try { await this.sendHello(); } catch (e) { this._emit('error', e); }

    // 2. Time sync — Web BLE doesn't always surface RTC_LOST quickly enough,
    //    so we proactively check current strap clock and set if drifted.
    try {
      const strapUnix = await this.getClock();
      const hostUnix = Math.floor(Date.now() / 1000);
      if (strapUnix && Math.abs(hostUnix - strapUnix) > RTC_DRIFT_THRESHOLD_S) {
        await this.setClock();
      }
    } catch (e) { this._emit('error', e); }

    // 3. Backfill historical data BEFORE realtime so we don't intermingle.
    try {
      await this.downloadHistory();
    } catch (e) {
      this._emit('error', e);
    }

    // 4. Start realtime
    try {
      await this.startRealtime();
    } catch (e) { this._emit('error', e); }

    // 5. Initial battery sample
    this.getBatteryLevel().catch(() => {});
  }

  async disconnect() {
    this._intentionalDisconnect = true;
    if (this._batteryPollInterval) {
      clearInterval(this._batteryPollInterval);
      this._batteryPollInterval = null;
    }
    try { await this.stopRealtime(); } catch {}
    if (this.server && this.server.connected) this.server.disconnect();
    this.connected = false;
    this._setState('disconnected');
  }

  _onDisconnected() {
    this.connected = false;
    if (this._batteryPollInterval) {
      clearInterval(this._batteryPollInterval);
      this._batteryPollInterval = null;
    }
    // Drain any pending metadata waiter so a dump-in-flight rejects promptly.
    this._metaQueue.clear();
    if (this._historicalDumpInFlight) {
      this._emit('historyError', new Error('disconnected during dump'));
      this._historicalDumpInFlight = false;
    }
    if (this._intentionalDisconnect) return;
    this._setState('reconnecting');
    setTimeout(() => this._tryReconnect(), this._reconnectBackoff);
    this._reconnectBackoff = Math.min(this._reconnectBackoff * 2, RECONNECT_MAX_MS);
  }

  async _tryReconnect() {
    try { await this._connect(); }
    catch (err) {
      this._setState('reconnecting');
      this._emit('error', err);
      setTimeout(() => this._tryReconnect(), this._reconnectBackoff);
      this._reconnectBackoff = Math.min(this._reconnectBackoff * 2, RECONNECT_MAX_MS);
    }
  }

  // ----- notification handlers --------------------------------------------

  _onData(e) {
    const v = bytesOf(e.target.value);
    let pkt;
    try { pkt = WhoopPacket.fromData(v); }
    catch (err) { this._emit('error', err); return; }

    switch (pkt.type) {
      case PacketType.REALTIME_DATA: {
        const decoded = decodePacket(pkt);
        this._emit('sample', decoded);
        break;
      }
      case PacketType.HISTORICAL_DATA: {
        try {
          const rec = parseHistorical(pkt.data);
          this._emit('historicalSample', rec);
        } catch (err) { this._emit('error', err); }
        break;
      }
      case PacketType.METADATA: {
        const meta = decodePacket(pkt);
        this._metaQueue.push(meta);
        this._emit('metadata', meta);
        break;
      }
      case PacketType.CONSOLE_LOGS: {
        const decoded = decodePacket(pkt);
        if (decoded.text) this._emit('log', decoded.text);
        break;
      }
      case PacketType.REALTIME_RAW_DATA:
      case PacketType.REALTIME_IMU_DATA_STREAM:
      case PacketType.HISTORICAL_IMU_DATA_STREAM: {
        this._emit('imu', { packetType: pkt.type, data: pkt.data });
        break;
      }
      default:
        // Silently drop unknown types.
        break;
    }
  }

  _onResponse(e) {
    const v = bytesOf(e.target.value);
    let pkt;
    try { pkt = WhoopPacket.fromData(v); }
    catch { return; }
    // Cache the well-known responses for callers waiting on them.
    if (pkt.cmd === CommandNumber.GET_BATTERY_LEVEL) {
      const pct = parseBatteryResponse(pkt.data);
      if (pct != null) { this.batteryPct = pct; this._emit('battery', pct); }
    } else if (pkt.cmd === CommandNumber.GET_CLOCK) {
      const unix = parseClockResponse(pkt.data);
      if (unix != null) { this.lastClockUnix = unix; this._emit('clock', unix); }
    } else if (pkt.cmd === CommandNumber.GET_HELLO_HARVARD) {
      const hello = parseHelloResponse(pkt.data);
      if (hello && !hello.partial) {
        this.charging = hello.charging;
        this.isWorn = hello.isWorn;
        this.serial = hello.serial ?? this.serial;
        this._emit('hello', hello);
      }
    }
    this._emit('response', { cmd: pkt.cmd, data: pkt.data });
  }

  _onEvent(e) {
    const v = bytesOf(e.target.value);
    let pkt;
    try { pkt = WhoopPacket.fromData(v); }
    catch { return; }
    if (pkt.type !== PacketType.EVENT) return;
    const evt = decodePacket(pkt);

    // Surface state-relevant ones onto the client itself + emit:
    switch (pkt.cmd) {
      case EventNumber.WRIST_ON:  this.isWorn = true; break;
      case EventNumber.WRIST_OFF: this.isWorn = false; break;
      case EventNumber.CHARGING_ON:  this.charging = true; break;
      case EventNumber.CHARGING_OFF: this.charging = false; break;
      case EventNumber.RTC_LOST:
        // Re-sync clock ASAP.
        this.setClock().catch(() => {});
        break;
      case EventNumber.HIGH_FREQ_SYNC_PROMPT:
        // Strap is asking for a sync. Drain history.
        this.downloadHistory().catch(() => {});
        break;
    }
    this._emit('event', evt);
  }

  // ----- command senders --------------------------------------------------

  async _sendCommand(cmd, payload = new Uint8Array()) {
    if (!this.charCmd) throw new Error('Not connected');
    const frame = buildCommandFrame(cmd, payload, this._seq);
    this._seq = (this._seq + 1) & 0xff;
    await this.charCmd.writeValue(frame);
  }

  async startRealtime() {
    await this._sendCommand(CommandNumber.TOGGLE_REALTIME_HR, new Uint8Array([0x01]));
  }

  async stopRealtime() {
    await this._sendCommand(CommandNumber.TOGGLE_REALTIME_HR, new Uint8Array([0x00]));
  }

  async getBatteryLevel() {
    if (!this.connected) return;
    try { await this._sendCommand(CommandNumber.GET_BATTERY_LEVEL, new Uint8Array([0x00])); }
    catch (err) { console.warn('[WhoopClient] battery poll failed', err); }
  }

  async sendHello() {
    await this._sendCommand(CommandNumber.GET_HELLO_HARVARD, new Uint8Array([0x00]));
  }

  async getClock() {
    return new Promise(async (resolve) => {
      let resolved = false;
      const dispose = this.on('clock', (unix) => {
        if (resolved) return;
        resolved = true;
        dispose();
        resolve(unix);
      });
      setTimeout(() => { if (!resolved) { dispose(); resolve(null); } }, 3000);
      await this._sendCommand(CommandNumber.GET_CLOCK, new Uint8Array([0x00]));
    });
  }

  async setClock(unix = Math.floor(Date.now() / 1000)) {
    const buf = new Uint8Array(4);
    buf[0] = unix & 0xff;
    buf[1] = (unix >>> 8) & 0xff;
    buf[2] = (unix >>> 16) & 0xff;
    buf[3] = (unix >>> 24) & 0xff;
    await this._sendCommand(CommandNumber.SET_CLOCK, buf);
  }

  async getDataRange() {
    await this._sendCommand(CommandNumber.GET_DATA_RANGE, new Uint8Array([0x00]));
  }

  async runHaptics(pattern = 0) {
    await this._sendCommand(CommandNumber.RUN_HAPTICS_PATTERN, new Uint8Array([pattern & 0xff]));
  }

  async abortHistoricalTransmits() {
    await this._sendCommand(CommandNumber.ABORT_HISTORICAL_TRANSMITS, new Uint8Array([0x00]));
  }

  /**
   * Start the raw-data stream: REALTIME_RAW_DATA (type 43) + IMU stream
   * packets (type 51) start flowing on the data char. Body layouts are
   * still being mapped — they get emitted as 'imu' events with raw bytes
   * so the UI can capture and inspect them.
   */
  async startRawData() {
    await this._sendCommand(CommandNumber.START_RAW_DATA, new Uint8Array([0x01]));
    this._rawActive = true;
  }

  async stopRawData() {
    await this._sendCommand(CommandNumber.STOP_RAW_DATA, new Uint8Array([0x01]));
    this._rawActive = false;
  }

  async toggleImuMode(enable = true) {
    await this._sendCommand(CommandNumber.TOGGLE_IMU_MODE, new Uint8Array([enable ? 0x01 : 0x00]));
  }

  /**
   * Toggle the standard BLE Heart Rate Profile (Service 0x180D). When on,
   * any third-party fitness app (Strava, Zwift, Peloton, Apple Watch
   * companions, etc.) can pair with the strap as a regular HR monitor.
   * Huge unlock — the strap already does all the work, this just exposes it.
   */
  async toggleGenericHrProfile(enable = true) {
    await this._sendCommand(CommandNumber.TOGGLE_GENERIC_HR_PROFILE, new Uint8Array([enable ? 0x01 : 0x00]));
    this._genericHrEnabled = enable;
  }

  // ----- alarm controls ---------------------------------------------------
  //
  // The strap can wake you with a vibration at a set time — even if your
  // phone/mac is in another room. Three commands:
  //   SET_ALARM_TIME (66)  — arm: payload = u32 LE unix epoch
  //   RUN_ALARM (68)       — fire immediately (also tests the haptic)
  //   DISABLE_ALARM (69)   — cancel a previously-armed alarm

  async setAlarm(unixTime) {
    if (!Number.isFinite(unixTime) || unixTime <= 0) throw new Error('alarm time invalid');
    const buf = new Uint8Array(4);
    buf[0] = unixTime & 0xff;
    buf[1] = (unixTime >>> 8) & 0xff;
    buf[2] = (unixTime >>> 16) & 0xff;
    buf[3] = (unixTime >>> 24) & 0xff;
    await this._sendCommand(CommandNumber.SET_ALARM_TIME, buf);
  }

  async runAlarmNow() {
    await this._sendCommand(CommandNumber.RUN_ALARM, new Uint8Array([0x00]));
  }

  async disableAlarm() {
    await this._sendCommand(CommandNumber.DISABLE_ALARM, new Uint8Array([0x00]));
  }

  /**
   * cmd 98 GET_EXTENDED_BATTERY_INFO — voltage / current / temperature /
   * cycle count / state-of-charge. Response layout is unconfirmed; we just
   * fire the command and the response flows out as a 'response' event
   * (cmd=98) so the caller can inspect the raw bytes.
   */
  async getExtendedBatteryInfo() {
    await this._sendCommand(CommandNumber.GET_EXTENDED_BATTERY_INFO, new Uint8Array([0x00]));
  }

  /**
   * cmd 123 SELECT_WRIST — tell the strap which wrist it's on (0=left, 1=right).
   * Affects motion classification.
   */
  async selectWrist(side = 'left') {
    const byte = side === 'right' ? 0x01 : 0x00;
    await this._sendCommand(CommandNumber.SELECT_WRIST, new Uint8Array([byte]));
  }

  /**
   * cmd 96 ENTER_HIGH_FREQ_SYNC — bulk-flash dump fast mode. Pairs with
   * exitHighFreqSync(). The strap should switch to maximum BLE throughput
   * for a fast historical drain.
   */
  async enterHighFreqSync() {
    await this._sendCommand(CommandNumber.ENTER_HIGH_FREQ_SYNC, new Uint8Array([0x00]));
  }

  async exitHighFreqSync() {
    await this._sendCommand(CommandNumber.EXIT_HIGH_FREQ_SYNC, new Uint8Array([0x00]));
  }

  // ----- historical data dump ---------------------------------------------
  //
  // Implements the state machine documented in vendor/whoomp/whoomp.js:292-325.
  // The strap floods METADATA + HISTORICAL_DATA packets onto the data
  // characteristic; we ack each batch with HISTORICAL_DATA_RESULT(trim) until
  // HISTORY_COMPLETE arrives.

  async downloadHistory() {
    if (!this.connected) return { samples: 0 };
    if (this._historicalDumpInFlight) return { samples: 0, alreadyRunning: true };
    this._historicalDumpInFlight = true;
    this._metaQueue.clear();
    this._emit('historyStart', {});

    let samplesReceived = 0;
    const onSample = this.on('historicalSample', () => { samplesReceived++; });

    try {
      await this._sendCommand(CommandNumber.SEND_HISTORICAL_DATA, new Uint8Array([0x00]));

      while (true) {
        // Wait for an END or COMPLETE — skip START frames.
        let meta;
        do {
          meta = await this._metaQueue.pop(META_QUEUE_TIMEOUT_MS);
        } while (meta.kind !== 'historyEnd' && meta.kind !== 'historyComplete');

        if (meta.kind === 'historyComplete') {
          this._emit('historyComplete', { samples: samplesReceived });
          return { samples: samplesReceived };
        }

        // Ack the batch by echoing trim. Payload = [0x01][trim u32 LE][0 u32].
        const ack = new Uint8Array(9);
        ack[0] = 0x01;
        ack[1] = meta.trim & 0xff;
        ack[2] = (meta.trim >>> 8) & 0xff;
        ack[3] = (meta.trim >>> 16) & 0xff;
        ack[4] = (meta.trim >>> 24) & 0xff;
        // bytes 5..9 stay zero
        await this._sendCommand(CommandNumber.HISTORICAL_DATA_RESULT, ack);
        this._emit('historyProgress', { samples: samplesReceived, trim: meta.trim });
      }
    } catch (err) {
      this._emit('historyError', err);
      throw err;
    } finally {
      onSample();
      this._historicalDumpInFlight = false;
    }
  }
}

// Helpers ----------------------------------------------------------------

function bytesOf(dataView) {
  // The browser hands us a DataView; convert to a plain Uint8Array view.
  return new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength);
}
