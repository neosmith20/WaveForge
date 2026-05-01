'use strict';

// ─── Address map (file offsets, verified against DM-1701 codeplug format) ──────
// EEPROM region: file_offset = hardware_addr (direct)
// SPI flash region: file_offset = hardware_addr - 0x70000
const ADDR = {
  DEVICE_INFO:      0x0080,
  GENERAL_SETTINGS: 0x00E0,   // radioName[8] + radioId[4]
  CHAN_BITMAP:       0x3780,   // 16 bytes, bits 0..127 = channels 1..128
  CHANNELS:          0x3790,   // 56 bytes each
  BOOT_LINE1:        0x7540,
  BOOT_LINE2:        0x7550,
  VFO_A:             0x7590,
  ZONE_BITMAP:       0x8010,   // 32 bytes
  ZONE_LIST:         0x8030,   // 48 bytes each (16-ch format) or 176 bytes (80-ch format)
  ZONE_FMT_PROBE:    0x806F,   // detection byte: ≤0x04 → 80-ch format, else 16-ch format
  CONTACTS:          0x17620,  // 24 bytes each (hw 0x87620 - 0x70000)
  RXG_LEN:           0x1D620,
  RXG_DATA:          0x1D6A0,
  LAST_USED_CHANNELS: 0x06000,
  CUSTOM_DATA_START:  0x1EE60,
  CUSTOM_DATA_END:    0x20000,
};

const CHANNEL_STRUCT_SIZE  = 56;
const CONTACT_STRUCT_SIZE  = 24;
const RXG_LEN_SIZE        = 3;
const RXG_DATA_SIZE       = 82;
const LAST_USED_CHANNELS_SIZE = 74;

const CHANNELS_MAX = 128;
const ZONES_MAX    = 68;
const CONTACTS_MAX = 1024;
const RXG_MAX      = 76;
const CHANNEL_DEBUG_NUMBERS = new Set([1, 5, 6, 41, 42]);

const CUSTOM_DATA_MAGIC             = 'OpenGD77';
const CUSTOM_DATA_HEADER_SIZE       = CUSTOM_DATA_MAGIC.length + 4;
const CUSTOM_DATA_BLOCK_HEADER_SIZE = 8;
const CUSTOM_DATA_TYPE = {
  UNINITIALISED: 0xFF,
  IMAGE:         0x01,
  MELODY:        0x02,
  SATELLITE:     0x03,
  THEME_DAY:     0x04,
  THEME_NIGHT:   0x05,
};
const CUSTOM_DATA_SIZE = ADDR.CUSTOM_DATA_END - ADDR.CUSTOM_DATA_START;
const LAST_USED_CHANNELS_MAGIC = 'LUCZ';

const BOOT_IMAGE_W    = 128;
const BOOT_IMAGE_H    = 64;
const BOOT_IMAGE_SIZE = BOOT_IMAGE_W * BOOT_IMAGE_H / 8;  // 1024 bytes
const BOOT_TEXT_LINE_LEN = 16;
const BOOT_TUNE_MAX   = 255;
const BOOT_TUNE_ENTRY = 2;
const BOOT_TUNE_SIZE  = 512;

const CSS_DCS          = 0x8000;
const CSS_DCS_INVERTED = 0x4000;
const CSS_DCS_MASK     = 0xC000;

const FLAG4_BW_25K  = 0x02;
const FLAG4_RX_ONLY = 0x04;
const FLAG2_TS2     = 0x40;

const CALL_TYPE     = { 0: 'Group', 1: 'Private', 2: 'All' };
const CALL_TYPE_REV = { Group: 0, Private: 1, All: 2 };

// ─── Read helpers ──────────────────────────────────────────────────────────────

function bcd2int(bcd) {
  let result = 0, mult = 1;
  while (bcd > 0) { result += (bcd & 0xF) * mult; bcd >>>= 4; mult *= 10; }
  return result;
}

function byteSwap32(val) {
  return (((val & 0xFF) << 24) | (((val >>> 8) & 0xFF) << 16) |
          (((val >>> 16) & 0xFF) << 8) | ((val >>> 24) & 0xFF)) >>> 0;
}

function readString(view, offset, maxLen) {
  const bytes = [];
  for (let i = 0; i < maxLen; i++) {
    const b = view.getUint8(offset + i);
    if (b === 0x00 || b === 0xFF) break;
    bytes.push(b);
  }
  return new TextDecoder('ascii').decode(new Uint8Array(bytes)).trim();
}

function readFreq(view, offset) {
  return bcd2int(view.getUint32(offset, true));
}

function freqToMHz(tenHz) {
  return (tenHz / 100000).toFixed(5);
}

function readTgId(view, offset) {
  return bcd2int(byteSwap32(view.getUint32(offset, true)));
}

function hexBytes(data, count = data.length) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return Array.from(bytes.subarray(0, count), b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

function decodeCss(raw) {
  if (raw === 0 || raw === 0xFFFF) return null;
  const type = raw & CSS_DCS_MASK;
  if (type === 0) {
    const tenths = bcd2int(raw);
    return { kind: 'CTCSS', value: (tenths / 10).toFixed(1) + ' Hz', str: (tenths / 10).toFixed(1) };
  }
  const inverted = (type & CSS_DCS_INVERTED) !== 0;
  const code = raw & ~CSS_DCS_MASK;
  const str = 'D' + code.toString().padStart(3, '0') + (inverted ? 'I' : 'N');
  return { kind: 'DCS', value: str, str };
}

// ─── Write helpers ─────────────────────────────────────────────────────────────

function int2bcd(n) {
  if (n <= 0) return 0;
  n = Math.round(n);
  let result = 0, shift = 0;
  while (n > 0) { result |= (n % 10) << shift; n = Math.floor(n / 10); shift += 4; }
  return result >>> 0;
}

function writeString(view, offset, maxLen, str) {
  const encoded = new TextEncoder().encode((str || '').substring(0, maxLen));
  for (let i = 0; i < maxLen; i++) {
    view.setUint8(offset + i, i < encoded.length ? encoded[i] : 0xFF);
  }
}

function readAsciiLine(view, offset, maxLen) {
  const bytes = [];
  for (let i = 0; i < maxLen; i++) {
    const b = view.getUint8(offset + i);
    if (b === 0x00 || b === 0xFF) break;
    bytes.push(b);
  }
  return String.fromCharCode(...bytes);
}

function writeAsciiLine(view, offset, maxLen, str, fieldName = 'Text') {
  const text = String(str || '').substring(0, maxLen);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code > 0x7E) {
      throw new Error(`${fieldName} must use printable ASCII characters only.`);
    }
  }
  for (let i = 0; i < maxLen; i++) {
    view.setUint8(offset + i, i < text.length ? text.charCodeAt(i) : 0xFF);
  }
}

function mhzToTenHz(mhzStr) {
  return Math.round(parseFloat(mhzStr) * 100000);
}

function encodeCss(cssStr) {
  if (!cssStr || !cssStr.trim()) return 0;
  const s = cssStr.trim().toUpperCase();
  if (s.startsWith('D')) {
    const code = parseInt(s.substring(1, 4), 10) || 0;
    const inverted = s.endsWith('I');
    return (CSS_DCS | (inverted ? CSS_DCS_INVERTED : 0) | code) & 0xFFFF;
  }
  const hz = parseFloat(s);
  return isNaN(hz) ? 0 : int2bcd(Math.round(hz * 10)) & 0xFFFF;
}

function fillFF(view, offset, len) {
  for (let i = 0; i < len; i++) view.setUint8(offset + i, 0xFF);
}

function fillZero(view, offset, len) {
  for (let i = 0; i < len; i++) view.setUint8(offset + i, 0x00);
}

function asciiMatches(bytes, offset, str) {
  if (offset + str.length > bytes.length) return false;
  for (let i = 0; i < str.length; i++) {
    if (bytes[offset + i] !== str.charCodeAt(i)) return false;
  }
  return true;
}

function writeAscii(bytes, offset, str) {
  for (let i = 0; i < str.length; i++) bytes[offset + i] = str.charCodeAt(i);
}

function readUint32LE(bytes, offset) {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0;
}

function writeUint32LE(bytes, offset, value) {
  bytes[offset]     = value & 0xFF;
  bytes[offset + 1] = (value >>> 8) & 0xFF;
  bytes[offset + 2] = (value >>> 16) & 0xFF;
  bytes[offset + 3] = (value >>> 24) & 0xFF;
}

// ─── CodeplugParser ────────────────────────────────────────────────────────────

class CodeplugParser {
  constructor(buffer) {
    if (buffer.byteLength < 0x20000) {
      throw new Error(`File is ${buffer.byteLength} bytes — expected at least 131072 (128 KB)`);
    }
    this.buf      = buffer;
    this.view     = new DataView(buffer);
    this.filename = null;
    this._generalSettings = null;
    this._channels = null;
    this._zones    = null;
    this._contacts = null;
    this._rxGroups = null;

    // Detect zone format using the probe byte at EEPROM 0x806F (same address
    // the firmware checks in codeplugInitChannelsPerZone()).
    //
    // In 80-ch (OpenGD77 extended) format, 0x806F is the HIGH byte of zone 0's
    // channel[23].  Max channel index is 1024 (0x400), so this byte is 0x00–0x04
    // when that slot holds a real channel.  When the slot is unused it may be:
    //   • 0x00  — written by this CPS (writeZone pads unused slots with 0x0000)
    //   • 0xFF  — written by the original OpenGD77 CPS (leaves unused slots as
    //             0xFFFF, the erased-flash default)
    //
    // In 16-ch (original Tytera) format, 0x806F is the LAST byte of zone 1's
    // name.  If the name is shorter than 16 chars this byte is 0xFF (padding);
    // if the name is exactly 16 chars it is a printable ASCII character (0x20–0x7E).
    //
    // Distinguishing rule:
    //   probeByte ∈ [0x05, 0xFE]  → must be a zone-name ASCII character → 16-ch
    //   probeByte ∈ [0x00, 0x04]  → channel-index upper byte            → 80-ch
    //   probeByte = 0xFF           → ambiguous; could be an unused 80-ch slot
    //                                (OpenGD77 CPS leaves 0xFFFF) or a short
    //                                16-ch zone-1 name → default to 80-ch
    const probeByte = this.view.getUint8(ADDR.ZONE_FMT_PROBE);
    this._channelsPerZone = (probeByte >= 0x05 && probeByte <= 0xFE) ? 16 : 80;
    this._zoneStructSize  = 16 + this._channelsPerZone * 2;  // 48 or 176
    this._channelDebugOffsets = [];
  }

  _channelBaseOffset(slotIndex) {
    const bank = Math.floor(slotIndex / 128);
    const indexInBank = slotIndex % 128;
    if (bank === 0) {
      return ADDR.CHANNELS + indexInBank * CHANNEL_STRUCT_SIZE;
    }

    const bankHeaderBase = 0x0B1B0 + (bank - 1) * (16 + 128 * CHANNEL_STRUCT_SIZE);
    return bankHeaderBase + 16 + indexInBank * CHANNEL_STRUCT_SIZE;
  }

  _logChannelDebugSummary() {
    if (this._channelDebugOffsets.length === 0) return;
    const sorted = [...this._channelDebugOffsets].sort((a, b) => a.number - b.number);
    const spacing = sorted.slice(1).map((entry, idx) => ({
      from: sorted[idx].number,
      to: entry.number,
      delta: entry.fileOffset - sorted[idx].fileOffset,
      expectedStrideDelta: (entry.number - sorted[idx].number) * CHANNEL_STRUCT_SIZE,
    }));
    console.log('[CPS] channel parser stride check', {
      stride: CHANNEL_STRUCT_SIZE,
      offsets: sorted.map(({ number, slotIndex, fileOffset, bank }) => ({
        number,
        slotIndex,
        bank,
        fileOffset: `0x${fileOffset.toString(16).toUpperCase()}`
      })),
      spacing,
    });
  }

  // ── Zone format ───────────────────────────────────────────────────────────────

  get zoneFormat() {
    return this._channelsPerZone === 80 ? 'opengd77' : 'original';
  }

  // ── General settings ─────────────────────────────────────────────────────────

  get generalSettings() {
    if (this._generalSettings) return this._generalSettings;
    const v    = this.view;
    const base = ADDR.GENERAL_SETTINGS;
    const radioName = readString(v, base, 8);
    const dmrId     = bcd2int(byteSwap32(v.getUint32(base + 8, true)));
    this._generalSettings = { radioName, dmrId };
    return this._generalSettings;
  }

  writeGeneralSettings(gs) {
    const v    = this.view;
    const base = ADDR.GENERAL_SETTINGS;
    writeString(v, base, 8, (gs.radioName || '').toUpperCase());
    v.setUint32(base + 8, byteSwap32(int2bcd(gs.dmrId || 0)), true);
    this._generalSettings = null;
  }

  // ── Boot text ────────────────────────────────────────────────────────────────

  get bootText() {
    return {
      line1: readAsciiLine(this.view, ADDR.BOOT_LINE1, BOOT_TEXT_LINE_LEN),
      line2: readAsciiLine(this.view, ADDR.BOOT_LINE2, BOOT_TEXT_LINE_LEN),
    };
  }

  writeBootText({ line1 = '', line2 = '' }) {
    writeAsciiLine(this.view, ADDR.BOOT_LINE1, BOOT_TEXT_LINE_LEN, line1, 'Boot text line 1');
    writeAsciiLine(this.view, ADDR.BOOT_LINE2, BOOT_TEXT_LINE_LEN, line2, 'Boot text line 2');
  }

  // ── Channels ─────────────────────────────────────────────────────────────────

  get channels() {
    if (this._channels) return this._channels;
    const v      = this.view;
    const result = [];
    this._channelDebugOffsets = [];
    for (let i = 0; i < CHANNELS_MAX; i++) {
      const byteIdx = Math.floor(i / 8);
      if (!(v.getUint8(ADDR.CHAN_BITMAP + byteIdx) & (1 << (i % 8)))) continue;
      result.push(this._decodeChannel(v, this._channelBaseOffset(i), i + 1, i));
    }
    this._logChannelDebugSummary();
    this._channels = result;
    return result;
  }

  _decodeChannel(v, base, number, slotIndex) {
    // struct_codeplugChannel_t (56 bytes on disk):
    //  +0  name[16]   +16 rxFreq u32 LE-BCD   +20 txFreq u32 LE-BCD
    //  +24 chMode     +32 rxTone u16           +34 txTone u16
    //  +44 txColor    +46 contact u16          +49 flag2  +51 flag4
    const name       = readString(v, base,      16);
    const rxFreq     = readFreq(v,  base + 16);
    const txFreq     = readFreq(v,  base + 20);
    const mode       = v.getUint8(base + 24);
    const rxToneRaw  = v.getUint16(base + 32, true);
    const txToneRaw  = v.getUint16(base + 34, true);
    const colorCode  = v.getUint8(base + 44) & 0x0F;
    const contactIdx = v.getUint16(base + 46, true);
    const flag2      = v.getUint8(base + 49);
    const flag4      = v.getUint8(base + 51);
    const isDMR      = mode !== 0;
    const isTS2      = !!(flag2 & FLAG2_TS2);
    const bw25k      = !!(flag4 & FLAG4_BW_25K);
    const rxOnly     = !!(flag4 & FLAG4_RX_ONLY);
    const rxCss      = isDMR ? null : decodeCss(rxToneRaw);
    const txCss      = isDMR ? null : decodeCss(txToneRaw);
    const decoded = {
      slotIndex,
      number,
      name,
      rxMHz:      freqToMHz(rxFreq),
      txMHz:      freqToMHz(txFreq),
      mode:       isDMR ? 'DMR' : 'FM',
      timeslot:   isDMR ? (isTS2 ? 2 : 1) : null,
      colorCode:  isDMR ? colorCode : null,
      contactIdx: isDMR ? contactIdx : null,
      bandwidth:  isDMR ? null : (bw25k ? '25K' : '12.5K'),
      css:        rxCss,
      rxCssStr:   rxCss ? rxCss.str : '',
      txCssStr:   txCss ? txCss.str : '',
      rxOnly,
    };

    if (CHANNEL_DEBUG_NUMBERS.has(number)) {
      const raw = new Uint8Array(this.buf, base, Math.min(32, CHANNEL_STRUCT_SIZE));
      const bank = Math.floor(slotIndex / 128);
      this._channelDebugOffsets.push({ number, slotIndex, bank, fileOffset: base });
      console.log('[CPS] channel parser debug', {
        number,
        slotIndex,
        bank,
        stride: CHANNEL_STRUCT_SIZE,
        fileOffset: `0x${base.toString(16).toUpperCase()}`,
        first32: hexBytes(raw, 32),
        decodedName: decoded.name,
      });
    }

    return decoded;
  }

  writeChannel(ch) {
    const v    = this.view;
    const base = ADDR.CHANNELS + ch.slotIndex * CHANNEL_STRUCT_SIZE;
    writeString(v, base, 16, ch.name);
    v.setUint32(base + 16, int2bcd(mhzToTenHz(ch.rxMHz)), true);
    v.setUint32(base + 20, int2bcd(mhzToTenHz(ch.txMHz)), true);
    v.setUint8(base + 24, ch.mode === 'DMR' ? 1 : 0);
    v.setUint16(base + 32, ch.mode === 'FM' ? encodeCss(ch.rxCssStr) : 0, true);
    v.setUint16(base + 34, ch.mode === 'FM' ? encodeCss(ch.txCssStr) : 0, true);
    const existCC = v.getUint8(base + 44);
    v.setUint8(base + 44, ch.mode === 'DMR' ? ((existCC & 0xF0) | (ch.colorCode & 0x0F)) : (existCC & 0xF0));
    v.setUint16(base + 46, ch.mode === 'DMR' ? (ch.contactIdx || 0) : 0, true);
    let flag2 = v.getUint8(base + 49) & ~FLAG2_TS2;
    if (ch.mode === 'DMR' && ch.timeslot === 2) flag2 |= FLAG2_TS2;
    v.setUint8(base + 49, flag2);
    let flag4 = v.getUint8(base + 51);
    flag4 = ch.rxOnly ? (flag4 | FLAG4_RX_ONLY) : (flag4 & ~FLAG4_RX_ONLY);
    if (ch.mode === 'FM') flag4 = ch.bandwidth === '25K' ? (flag4 | FLAG4_BW_25K) : (flag4 & ~FLAG4_BW_25K);
    v.setUint8(base + 51, flag4);
    // Mark bitmap
    const bi = Math.floor(ch.slotIndex / 8);
    v.setUint8(ADDR.CHAN_BITMAP + bi, v.getUint8(ADDR.CHAN_BITMAP + bi) | (1 << (ch.slotIndex % 8)));
    this._channels = null;
  }

  addChannel() {
    for (let i = 0; i < CHANNELS_MAX; i++) {
      const bi = Math.floor(i / 8);
      if (!(this.view.getUint8(ADDR.CHAN_BITMAP + bi) & (1 << (i % 8)))) {
        fillFF(this.view, ADDR.CHANNELS + i * CHANNEL_STRUCT_SIZE, CHANNEL_STRUCT_SIZE);
        return i;
      }
    }
    return null;
  }

  deleteChannel(slotIndex) {
    const v  = this.view;
    const bi = Math.floor(slotIndex / 8);
    v.setUint8(ADDR.CHAN_BITMAP + bi, v.getUint8(ADDR.CHAN_BITMAP + bi) & ~(1 << (slotIndex % 8)));
    fillFF(v, ADDR.CHANNELS + slotIndex * CHANNEL_STRUCT_SIZE, CHANNEL_STRUCT_SIZE);
    this._channels = null;
  }

  reorderChannels(newSlotOrder) {
    // newSlotOrder: array of old slotIndex values in the desired new order.
    // Channels are packed into consecutive slots 0..N-1; zone references are remapped.
    const v = this.view;
    const n = newSlotOrder.length;

    // Snapshot raw bytes before touching anything to avoid read-after-write aliasing
    const snapshots = newSlotOrder.map(slot => {
      const start = ADDR.CHANNELS + slot * CHANNEL_STRUCT_SIZE;
      return new Uint8Array(this.buf.slice(start, start + CHANNEL_STRUCT_SIZE));
    });

    // old 1-based channel number → new 1-based channel number
    const oldNumToNew = {};
    newSlotOrder.forEach((oldSlot, newIdx) => { oldNumToNew[oldSlot + 1] = newIdx + 1; });

    // Clear every currently active slot
    for (let i = 0; i < CHANNELS_MAX; i++) {
      const bi = Math.floor(i / 8);
      if (v.getUint8(ADDR.CHAN_BITMAP + bi) & (1 << (i % 8))) {
        v.setUint8(ADDR.CHAN_BITMAP + bi, v.getUint8(ADDR.CHAN_BITMAP + bi) & ~(1 << (i % 8)));
        fillFF(v, ADDR.CHANNELS + i * CHANNEL_STRUCT_SIZE, CHANNEL_STRUCT_SIZE);
      }
    }

    // Write channels to consecutive slots 0..N-1
    snapshots.forEach((raw, newIdx) => {
      const dst = ADDR.CHANNELS + newIdx * CHANNEL_STRUCT_SIZE;
      for (let j = 0; j < CHANNEL_STRUCT_SIZE; j++) v.setUint8(dst + j, raw[j]);
      const bi = Math.floor(newIdx / 8);
      v.setUint8(ADDR.CHAN_BITMAP + bi, v.getUint8(ADDR.CHAN_BITMAP + bi) | (1 << (newIdx % 8)));
    });

    // Remap zone channel-list entries to new numbers
    for (let i = 0; i < ZONES_MAX; i++) {
      const bi = Math.floor(i / 8);
      if (!(v.getUint8(ADDR.ZONE_BITMAP + bi) & (1 << (i % 8)))) continue;
      const base = ADDR.ZONE_LIST + i * this._zoneStructSize;
      for (let j = 0; j < this._channelsPerZone; j++) {
        const ref = v.getUint16(base + 16 + j * 2, true);
        if (ref === 0 || ref === 0xFFFF) break;
        const mapped = oldNumToNew[ref];
        if (mapped !== undefined) v.setUint16(base + 16 + j * 2, mapped, true);
      }
    }

    this._channels = null;
    this._zones    = null;
  }

  // ── Zones ────────────────────────────────────────────────────────────────────

  get zones() {
    if (this._zones) return this._zones;
    const v      = this.view;
    const result = [];
    for (let i = 0; i < ZONES_MAX; i++) {
      const bi = Math.floor(i / 8);
      if (!(v.getUint8(ADDR.ZONE_BITMAP + bi) & (1 << (i % 8)))) continue;
      result.push(this._decodeZone(v, ADDR.ZONE_LIST + i * this._zoneStructSize, i + 1, i));
    }
    this._zones = result;
    return result;
  }

  _decodeZone(v, base, number, slotIndex) {
    const name     = readString(v, base, 16);
    const channels = [];
    for (let j = 0; j < this._channelsPerZone; j++) {
      const idx = v.getUint16(base + 16 + j * 2, true);
      if (idx === 0 || idx === 0xFFFF) break;
      channels.push(idx);
    }
    return { slotIndex, number, name, channels };
  }

  writeZone(zone) {
    const v    = this.view;
    const base = ADDR.ZONE_LIST + zone.slotIndex * this._zoneStructSize;
    writeString(v, base, 16, zone.name);
    for (let j = 0; j < this._channelsPerZone; j++) {
      v.setUint16(base + 16 + j * 2, j < zone.channels.length ? zone.channels[j] : 0, true);
    }
    const bi = Math.floor(zone.slotIndex / 8);
    v.setUint8(ADDR.ZONE_BITMAP + bi, v.getUint8(ADDR.ZONE_BITMAP + bi) | (1 << (zone.slotIndex % 8)));
    this._zones = null;
  }

  addZone() {
    for (let i = 0; i < ZONES_MAX; i++) {
      const bi = Math.floor(i / 8);
      if (!(this.view.getUint8(ADDR.ZONE_BITMAP + bi) & (1 << (i % 8)))) {
        fillFF(this.view, ADDR.ZONE_LIST + i * this._zoneStructSize, this._zoneStructSize);
        return i;
      }
    }
    return null;
  }

  deleteZone(slotIndex) {
    const v  = this.view;
    const bi = Math.floor(slotIndex / 8);
    v.setUint8(ADDR.ZONE_BITMAP + bi, v.getUint8(ADDR.ZONE_BITMAP + bi) & ~(1 << (slotIndex % 8)));
    fillFF(v, ADDR.ZONE_LIST + slotIndex * this._zoneStructSize, this._zoneStructSize);
    this._zones = null;
  }

  // ── Contacts ─────────────────────────────────────────────────────────────────

  get contacts() {
    if (this._contacts) return this._contacts;
    const v      = this.view;
    const result = [];
    for (let i = 0; i < CONTACTS_MAX; i++) {
      const base = ADDR.CONTACTS + i * CONTACT_STRUCT_SIZE;
      if (base + CONTACT_STRUCT_SIZE > this.buf.byteLength) break;
      if (v.getUint8(base) === 0xFF) break;
      const name = readString(v, base, 16);
      if (!name) continue;
      result.push({
        slotIndex:  i,
        number:     i + 1,
        name,
        tgNumber:   readTgId(v, base + 16),
        callType:   CALL_TYPE[v.getUint8(base + 20)] ?? 'Group',
        ringAlert:  !!v.getUint8(base + 21),
      });
    }
    this._contacts = result;
    return result;
  }

  writeContact(ct) {
    const v    = this.view;
    const base = ADDR.CONTACTS + ct.slotIndex * CONTACT_STRUCT_SIZE;
    writeString(v, base, 16, ct.name);
    v.setUint32(base + 16, byteSwap32(int2bcd(ct.tgNumber || 0)), true);
    v.setUint8(base + 20, CALL_TYPE_REV[ct.callType] ?? 0);
    v.setUint8(base + 21, ct.ringAlert ? 1 : 0);
    v.setUint8(base + 22, 0);
    v.setUint8(base + 23, 0);
    this._contacts = null;
  }

  addContact() {
    const count = this.contacts.length;
    if (count >= CONTACTS_MAX) return null;
    fillFF(this.view, ADDR.CONTACTS + count * CONTACT_STRUCT_SIZE, CONTACT_STRUCT_SIZE);
    return count;
  }

  deleteContact(slotIndex) {
    const v     = this.view;
    const total = this.contacts.length;
    for (let i = slotIndex; i < total - 1; i++) {
      const src = ADDR.CONTACTS + (i + 1) * CONTACT_STRUCT_SIZE;
      const dst = ADDR.CONTACTS + i * CONTACT_STRUCT_SIZE;
      for (let j = 0; j < CONTACT_STRUCT_SIZE; j++) v.setUint8(dst + j, v.getUint8(src + j));
    }
    fillFF(v, ADDR.CONTACTS + (total - 1) * CONTACT_STRUCT_SIZE, CONTACT_STRUCT_SIZE);
    this._contacts = null;
  }

  // ── RX Groups ────────────────────────────────────────────────────────────────

  get rxGroups() {
    if (this._rxGroups) return this._rxGroups;
    const v      = this.view;
    const result = [];
    for (let i = 0; i < RXG_MAX; i++) {
      const dataBase = ADDR.RXG_DATA + i * RXG_DATA_SIZE;
      if (dataBase + RXG_DATA_SIZE > this.buf.byteLength) break;
      if (v.getUint8(dataBase) === 0xFF) continue;
      const name = readString(v, dataBase, 16);
      if (!name) continue;
      const contacts = [];
      for (let j = 0; j < 32; j++) {
        const idx = v.getUint16(dataBase + 16 + j * 2, true);
        if (idx === 0 || idx === 0xFFFF) break;
        contacts.push(idx);
      }
      result.push({ number: i + 1, name, contacts });
    }
    this._rxGroups = result;
    return result;
  }

  _customDataBytes() {
    return new Uint8Array(this.buf, ADDR.CUSTOM_DATA_START, CUSTOM_DATA_SIZE);
  }

  _hasCustomDataHeader() {
    return asciiMatches(this._customDataBytes(), 0, CUSTOM_DATA_MAGIC);
  }

  _ensureCustomDataHeader() {
    const custom = this._customDataBytes();
    if (!asciiMatches(custom, 0, CUSTOM_DATA_MAGIC)) {
      custom.fill(0xFF);
      writeAscii(custom, 0, CUSTOM_DATA_MAGIC);
      writeUint32LE(custom, CUSTOM_DATA_MAGIC.length, 1);
    }
    return custom;
  }

  _findCustomDataBlock(typeToFind, uninitLength = 1, autoInit = false) {
    const custom = autoInit ? this._ensureCustomDataHeader() : this._customDataBytes();
    if (!asciiMatches(custom, 0, CUSTOM_DATA_MAGIC)) return -1;
    let pos = CUSTOM_DATA_HEADER_SIZE;

    while (pos < custom.length - CUSTOM_DATA_BLOCK_HEADER_SIZE) {
      if (custom[pos] === typeToFind) {
        const valid = typeToFind === CUSTOM_DATA_TYPE.UNINITIALISED
          ? (pos + CUSTOM_DATA_BLOCK_HEADER_SIZE + uninitLength <= custom.length - CUSTOM_DATA_BLOCK_HEADER_SIZE)
          : (
              pos + CUSTOM_DATA_BLOCK_HEADER_SIZE < custom.length - CUSTOM_DATA_BLOCK_HEADER_SIZE &&
              pos + CUSTOM_DATA_BLOCK_HEADER_SIZE + readUint32LE(custom, pos + 4) <= custom.length - CUSTOM_DATA_BLOCK_HEADER_SIZE
            );
        if (valid) return pos;
      }

      const blockLen = readUint32LE(custom, pos + 4);
      const nextPos = pos + CUSTOM_DATA_BLOCK_HEADER_SIZE + blockLen;
      if (nextPos <= pos) break;
      pos = nextPos;
    }

    return -1;
  }

  // ── Boot tune ─────────────────────────────────────────────────────────────────

  get bootTune() {
    const pos = this._findCustomDataBlock(CUSTOM_DATA_TYPE.MELODY);
    if (pos < 0) return [];
    const custom = this._customDataBytes();
    const entries = [];
    const dataPos = pos + CUSTOM_DATA_BLOCK_HEADER_SIZE;
    const dataLen = Math.min(readUint32LE(custom, pos + 4), BOOT_TUNE_SIZE);

    for (let i = 0; i + 1 < dataLen; i += BOOT_TUNE_ENTRY) {
      const note = custom[dataPos + i];
      const dur  = custom[dataPos + i + 1];
      if (note === 0 && dur === 0) break;
      entries.push({ note, dur });
    }
    return entries;
  }

  writeBootTune(entries) {
    const pos = this._findCustomDataBlock(CUSTOM_DATA_TYPE.MELODY, BOOT_TUNE_SIZE, true);
    if (pos < 0) throw new Error('No room left in OpenGD77 custom data for the boot melody.');
    const custom = this._customDataBytes();
    custom[pos]     = CUSTOM_DATA_TYPE.MELODY;
    custom[pos + 1] = 0;
    custom[pos + 2] = 0;
    custom[pos + 3] = 0;
    writeUint32LE(custom, pos + 4, BOOT_TUNE_SIZE);
    custom.fill(0x00, pos + CUSTOM_DATA_BLOCK_HEADER_SIZE, pos + CUSTOM_DATA_BLOCK_HEADER_SIZE + BOOT_TUNE_SIZE);

    const n = Math.min(entries.length, BOOT_TUNE_MAX);
    for (let i = 0; i < n; i++) {
      const base = pos + CUSTOM_DATA_BLOCK_HEADER_SIZE + i * BOOT_TUNE_ENTRY;
      custom[base]     = entries[i].note & 0xFF;
      custom[base + 1] = entries[i].dur  & 0xFF;
    }
  }

  // ── Band limits ───────────────────────────────────────────────────────────────
  // struct_codeplugDeviceInfo_t at DEVICE_INFO + 0..6:
  //   +0 minUHFFreq  +2 maxUHFFreq  +4 minVHFFreq  +6 maxVHFFreq
  // Each is a uint16_t stored little-endian BCD, value in MHz.

  get bandLimits() {
    const v    = this.view;
    const base = ADDR.DEVICE_INFO;
    return {
      minUHF: bcd2int(v.getUint16(base + 0, true)),
      maxUHF: bcd2int(v.getUint16(base + 2, true)),
      minVHF: bcd2int(v.getUint16(base + 4, true)),
      maxVHF: bcd2int(v.getUint16(base + 6, true)),
    };
  }

  writeBandLimits({ minUHF, maxUHF, minVHF, maxVHF }) {
    const v    = this.view;
    const base = ADDR.DEVICE_INFO;
    v.setUint16(base + 0, int2bcd(minUHF), true);
    v.setUint16(base + 2, int2bcd(maxUHF), true);
    v.setUint16(base + 4, int2bcd(minVHF), true);
    v.setUint16(base + 6, int2bcd(maxVHF), true);
  }

  // ── Boot image ────────────────────────────────────────────────────────────────

  get bootImage() {
    const pos = this._findCustomDataBlock(CUSTOM_DATA_TYPE.IMAGE);
    if (pos < 0) return null;
    const custom = this._customDataBytes();
    const dataPos = pos + CUSTOM_DATA_BLOCK_HEADER_SIZE;
    return custom.slice(dataPos, dataPos + BOOT_IMAGE_SIZE);
  }

  writeBootImage(bits) {
    const pos = this._findCustomDataBlock(CUSTOM_DATA_TYPE.IMAGE, BOOT_IMAGE_SIZE, true);
    if (pos < 0) throw new Error('No room left in OpenGD77 custom data for the boot image.');
    const custom = this._customDataBytes();
    custom[pos]     = CUSTOM_DATA_TYPE.IMAGE;
    custom[pos + 1] = 0;
    custom[pos + 2] = 0;
    custom[pos + 3] = 0;
    writeUint32LE(custom, pos + 4, BOOT_IMAGE_SIZE);
    custom.fill(0x00, pos + CUSTOM_DATA_BLOCK_HEADER_SIZE, pos + CUSTOM_DATA_BLOCK_HEADER_SIZE + BOOT_IMAGE_SIZE);
    const n = Math.min(bits.length, BOOT_IMAGE_SIZE);
    for (let i = 0; i < n; i++) custom[pos + CUSTOM_DATA_BLOCK_HEADER_SIZE + i] = bits[i];
  }

  // ── Serialise ─────────────────────────────────────────────────────────────────
  toArrayBuffer() { return this.buf.slice(0); }

  static createBlank() {
    const buf  = new ArrayBuffer(0x20000);
    const u8   = new Uint8Array(buf);
    const view = new DataView(buf);
    u8.fill(0xFF);
    // Zero bitmaps so no channels or zones appear as used
    for (let i = 0; i < 16; i++) view.setUint8(ADDR.CHAN_BITMAP + i, 0x00);
    for (let i = 0; i < 32; i++) view.setUint8(ADDR.ZONE_BITMAP + i, 0x00);
    // Mark 80-channel zone format so the probe byte (0x806F) reads as 0x00
    // (upper byte of channel index 23 in zone 0 — value ≤ 0x04 selects 80-ch format).
    view.setUint8(ADDR.ZONE_FMT_PROBE, 0x00);
    fillZero(view, ADDR.LAST_USED_CHANNELS, LAST_USED_CHANNELS_SIZE);
    for (let i = 0; i < LAST_USED_CHANNELS_MAGIC.length; i++) {
      view.setUint8(ADDR.LAST_USED_CHANNELS + i, LAST_USED_CHANNELS_MAGIC.charCodeAt(i));
    }
    fillFF(view, ADDR.CUSTOM_DATA_START, CUSTOM_DATA_SIZE);
    for (let i = 0; i < CUSTOM_DATA_MAGIC.length; i++) {
      view.setUint8(ADDR.CUSTOM_DATA_START + i, CUSTOM_DATA_MAGIC.charCodeAt(i));
    }
    view.setUint32(ADDR.CUSTOM_DATA_START + CUSTOM_DATA_MAGIC.length, 1, true);
    const p = new CodeplugParser(buf);
    p.filename = 'new_codeplug.cdmr';
    return p;
  }

  static async fromFile(file) {
    const buf    = await file.arrayBuffer();
    const parser = new CodeplugParser(buf);
    parser.filename = file.name;
    return parser;
  }
}
