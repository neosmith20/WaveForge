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
  ZONE_LIST:         0x8030,   // 176 bytes each
  CONTACTS:          0x17620,  // 24 bytes each (hw 0x87620 - 0x70000)
  RXG_LEN:           0x1D620,
  RXG_DATA:          0x1D6A0,
};

const CHANNEL_STRUCT_SIZE = 56;
const ZONE_STRUCT_SIZE    = 176;
const CONTACT_STRUCT_SIZE = 24;
const RXG_LEN_SIZE        = 3;
const RXG_DATA_SIZE       = 82;

const CHANNELS_MAX = 128;
const ZONES_MAX    = 68;
const CONTACTS_MAX = 1024;
const RXG_MAX      = 76;

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

  // ── Channels ─────────────────────────────────────────────────────────────────

  get channels() {
    if (this._channels) return this._channels;
    const v      = this.view;
    const result = [];
    for (let i = 0; i < CHANNELS_MAX; i++) {
      const byteIdx = Math.floor(i / 8);
      if (!(v.getUint8(ADDR.CHAN_BITMAP + byteIdx) & (1 << (i % 8)))) continue;
      result.push(this._decodeChannel(v, ADDR.CHANNELS + i * CHANNEL_STRUCT_SIZE, i + 1, i));
    }
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
    return {
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
      const base = ADDR.ZONE_LIST + i * ZONE_STRUCT_SIZE;
      for (let j = 0; j < 80; j++) {
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
      result.push(this._decodeZone(v, ADDR.ZONE_LIST + i * ZONE_STRUCT_SIZE, i + 1, i));
    }
    this._zones = result;
    return result;
  }

  _decodeZone(v, base, number, slotIndex) {
    const name     = readString(v, base, 16);
    const channels = [];
    for (let j = 0; j < 80; j++) {
      const idx = v.getUint16(base + 16 + j * 2, true);
      if (idx === 0 || idx === 0xFFFF) break;
      channels.push(idx);
    }
    return { slotIndex, number, name, channels };
  }

  writeZone(zone) {
    const v    = this.view;
    const base = ADDR.ZONE_LIST + zone.slotIndex * ZONE_STRUCT_SIZE;
    writeString(v, base, 16, zone.name);
    for (let j = 0; j < 80; j++) {
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
        fillFF(this.view, ADDR.ZONE_LIST + i * ZONE_STRUCT_SIZE, ZONE_STRUCT_SIZE);
        return i;
      }
    }
    return null;
  }

  deleteZone(slotIndex) {
    const v  = this.view;
    const bi = Math.floor(slotIndex / 8);
    v.setUint8(ADDR.ZONE_BITMAP + bi, v.getUint8(ADDR.ZONE_BITMAP + bi) & ~(1 << (slotIndex % 8)));
    fillFF(v, ADDR.ZONE_LIST + slotIndex * ZONE_STRUCT_SIZE, ZONE_STRUCT_SIZE);
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
