'use strict';

// ─── Address map (file offsets, verified against W0PWR_0223_0302.g77) ─────────
// EEPROM region: file_offset = hardware_addr (direct)
// SPI flash region: file_offset = hardware_addr - 0x70000
const ADDR = {
  DEVICE_INFO:      0x0080,   // struct_codeplugDeviceInfo_t
  GENERAL_SETTINGS: 0x00E0,   // struct_codeplugGeneralSettings_t: radioName[8] + radioId[4]
  CHAN_BITMAP:       0x3780,   // 16 bytes, bits 0..127 = channels 1..128
  CHANNELS:          0x3790,   // 56 bytes each
  BOOT_LINE1:        0x7540,
  BOOT_LINE2:        0x7550,
  VFO_A:             0x7590,
  ZONE_BITMAP:       0x8010,   // 32 bytes, bits = zones in use (hw: 0x8010)
  ZONE_LIST:         0x8030,   // 176 bytes each (hw: 0x8030)
  CONTACTS:          0x17620,  // 24 bytes each (hw: 0x87620 - 0x70000)
  RXG_LEN:           0x1D620,  // 3 bytes each (hw: 0x8D620 - 0x70000)
  RXG_DATA:          0x1D6A0,  // 80+2 bytes each (hw: 0x8D6A0 - 0x70000)
};

const CHANNEL_STRUCT_SIZE  = 56;
const ZONE_STRUCT_SIZE     = 176;  // OpenGD77 variant: name[16] + channels[80×uint16]
const CONTACT_STRUCT_SIZE  = 24;
const RXG_LEN_SIZE         = 3;
const RXG_DATA_SIZE        = 82;   // name[16] + contacts[33×uint16]

const CHANNELS_MAX = 128;   // bitmap covers 128; full codeplug supports 1024 but .g77 layout only provides 128 in EEPROM
const ZONES_MAX    = 68;
const CONTACTS_MAX = 1024;
const RXG_MAX      = 76;

// CSS_TYPE flag bits on CTCSS/DCS uint16
const CSS_DCS          = 0x8000;
const CSS_DCS_INVERTED = 0x4000;
const CSS_DCS_MASK     = 0xC000;

// flag4 bits
const FLAG4_BW_25K  = 0x02;
const FLAG4_RX_ONLY = 0x04;
const FLAG4_VOX     = 0x40;
const FLAG4_POWER   = 0x80;

// flag2 bits
const FLAG2_TS2 = 0x40;

// Contact call types
const CALL_TYPE = { 0: 'Group', 1: 'Private', 2: 'All' };

// ─── Helpers ───────────────────────────────────────────────────────────────────

function bcd2int(bcd) {
  let result = 0;
  let multiplier = 1;
  while (bcd > 0) {
    result += (bcd & 0x0F) * multiplier;
    bcd >>>= 4;
    multiplier *= 10;
  }
  return result;
}

function byteSwap32(val) {
  return (((val & 0xFF) << 24) |
          (((val >>> 8)  & 0xFF) << 16) |
          (((val >>> 16) & 0xFF) << 8)  |
          ((val >>> 24) & 0xFF)) >>> 0;
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
  // LE uint32 BCD, each nibble = one digit, value in 10-Hz units
  return bcd2int(view.getUint32(offset, true));  // returns Hz/10
}

function freqToMHz(tenHz) {
  return (tenHz / 100000).toFixed(5);
}

function readTgId(view, offset) {
  // Stored as LE uint32 BCD but logically BE: byteSwap32 then bcd2int
  const raw = view.getUint32(offset, true);
  return bcd2int(byteSwap32(raw));
}

function decodeCss(raw) {
  if (raw === 0 || raw === 0xFFFF) return null;
  const type = raw & CSS_DCS_MASK;
  if (type === 0) {
    // CTCSS — BCD tenths of Hz
    const tenths = bcd2int(raw);
    return { kind: 'CTCSS', value: (tenths / 10).toFixed(1) + ' Hz' };
  }
  const inverted = (type & CSS_DCS_INVERTED) !== 0;
  const code = raw & ~CSS_DCS_MASK;
  return { kind: 'DCS', value: 'D' + code.toString().padStart(3, '0') + (inverted ? 'I' : 'N') };
}

// ─── CodeplugParser ────────────────────────────────────────────────────────────

class CodeplugParser {
  constructor(buffer) {
    if (buffer.byteLength < 0x20000) {
      throw new Error(`File is ${buffer.byteLength} bytes — expected at least 131072 (128 KB)`);
    }
    this.buf = buffer;
    this.view = new DataView(buffer);
    this.filename = null;
    this._generalSettings = null;
    this._channels = null;
    this._zones = null;
    this._contacts = null;
    this._rxGroups = null;
  }

  // ── General settings ─────────────────────────────────────────────────────────

  get generalSettings() {
    if (this._generalSettings) return this._generalSettings;
    const v = this.view;
    const base = ADDR.GENERAL_SETTINGS;
    // struct: radioName[8] at base, radioId[4] at base+8 (but actual DMR ID stored separately)
    // From codeplug.c: CODEPLUG_ADDR_USER_DMRID = 0x00E8 (= base + 8)
    const radioName = readString(v, base, 8);
    const rawId     = v.getUint32(base + 8, true);
    const dmrId     = bcd2int(byteSwap32(rawId));
    this._generalSettings = { radioName, dmrId };
    return this._generalSettings;
  }

  // ── Channels ─────────────────────────────────────────────────────────────────

  get channels() {
    if (this._channels) return this._channels;
    const v = this.view;
    const result = [];

    // Read 16-byte in-use bitmap (channels 1..128)
    const bitmapOffset = ADDR.CHAN_BITMAP;
    for (let i = 0; i < CHANNELS_MAX; i++) {
      const byteIdx = Math.floor(i / 8);
      const bitMask = 1 << (i % 8);
      if (!(v.getUint8(bitmapOffset + byteIdx) & bitMask)) continue;

      const base = ADDR.CHANNELS + i * CHANNEL_STRUCT_SIZE;
      const ch = this._decodeChannel(v, base, i + 1);
      result.push(ch);
    }

    this._channels = result;
    return result;
  }

  _decodeChannel(v, base, number) {
    // struct_codeplugChannel_t layout (56 bytes on disk, NOT_IN_CODEPLUG fields excluded):
    // +0  name[16]
    // +16 rxFreq uint32 LE BCD (10-Hz units)
    // +20 txFreq uint32 LE BCD (10-Hz units)
    // +24 chMode uint8 (0=FM, else DMR)
    // +32 rxTone uint16 LE (CTCSS/DCS)
    // +34 txTone uint16 LE (CTCSS/DCS)
    // +43 rxGroupList uint8
    // +44 txColor uint8 (lower nibble = color code)
    // +46 contact uint16 LE (1-based)
    // +48 flag1, +49 flag2, +50 flag3, +51 flag4, +52 VFOoffsetFreq uint16
    // +54 VFOflag5, +55 sql
    const name       = readString(v, base + 0,  16);
    const rxFreq     = readFreq(v,  base + 16);
    const txFreq     = readFreq(v,  base + 20);
    const mode       = v.getUint8(base + 24);
    const rxToneRaw  = v.getUint16(base + 32, true);
    const txToneRaw  = v.getUint16(base + 34, true);
    const colorCode  = v.getUint8(base + 44) & 0x0F;
    const contactIdx = v.getUint16(base + 46, true);
    const flag2      = v.getUint8(base + 49);
    const flag4      = v.getUint8(base + 51);

    const isDMR   = mode !== 0;
    const isTS2   = !!(flag2 & FLAG2_TS2);
    const bw25k   = !!(flag4 & FLAG4_BW_25K);
    const rxOnly  = !!(flag4 & FLAG4_RX_ONLY);
    const css     = isDMR ? null : decodeCss(rxToneRaw);

    return {
      number,
      name,
      rxMHz: freqToMHz(rxFreq),
      txMHz: freqToMHz(txFreq),
      mode: isDMR ? 'DMR' : 'FM',
      timeslot: isDMR ? (isTS2 ? 2 : 1) : null,
      colorCode: isDMR ? colorCode : null,
      contactIdx: isDMR ? contactIdx : null,
      bandwidth: isDMR ? null : (bw25k ? '25K' : '12.5K'),
      css,
      rxOnly,
    };
  }

  // ── Zones ────────────────────────────────────────────────────────────────────

  get zones() {
    if (this._zones) return this._zones;
    const v = this.view;
    const result = [];

    // Zone in-use bitmap: 32 bytes at 0x8010, bits cover zones 0..68
    const bitmapOffset = ADDR.ZONE_BITMAP;
    for (let i = 0; i < ZONES_MAX; i++) {
      const byteIdx = Math.floor(i / 8);
      const bitMask = 1 << (i % 8);
      if (!(v.getUint8(bitmapOffset + byteIdx) & bitMask)) continue;

      const base = ADDR.ZONE_LIST + i * ZONE_STRUCT_SIZE;
      const zone = this._decodeZone(v, base, i + 1);
      result.push(zone);
    }

    this._zones = result;
    return result;
  }

  _decodeZone(v, base, number) {
    const name = readString(v, base, 16);
    const channels = [];
    for (let j = 0; j < 80; j++) {
      const idx = v.getUint16(base + 16 + j * 2, true);
      if (idx === 0 || idx === 0xFFFF) break;
      channels.push(idx);  // 1-based channel index
    }
    return { number, name, channels };
  }

  // ── Contacts ─────────────────────────────────────────────────────────────────

  get contacts() {
    if (this._contacts) return this._contacts;
    const v = this.view;
    const result = [];

    // Contacts have no in-use bitmap — scan until we hit a blank entry
    for (let i = 0; i < CONTACTS_MAX; i++) {
      const base = ADDR.CONTACTS + i * CONTACT_STRUCT_SIZE;
      if (base + CONTACT_STRUCT_SIZE > this.buf.byteLength) break;

      const firstByte = v.getUint8(base);
      if (firstByte === 0xFF) break;  // end of contact list

      const name = readString(v, base, 16);
      if (!name) continue;

      const tgNumber  = readTgId(v, base + 16);
      const callType  = v.getUint8(base + 20);
      const ringAlert = v.getUint8(base + 21);

      result.push({
        number: i + 1,
        name,
        tgNumber,
        callType: CALL_TYPE[callType] ?? 'Group',
        ringAlert: !!ringAlert,
      });
    }

    this._contacts = result;
    return result;
  }

  // ── RX Groups ────────────────────────────────────────────────────────────────

  get rxGroups() {
    if (this._rxGroups) return this._rxGroups;
    const v = this.view;
    const result = [];

    for (let i = 0; i < RXG_MAX; i++) {
      const lenBase  = ADDR.RXG_LEN  + i * RXG_LEN_SIZE;
      const dataBase = ADDR.RXG_DATA + i * RXG_DATA_SIZE;
      if (dataBase + RXG_DATA_SIZE > this.buf.byteLength) break;

      const firstByte = v.getUint8(dataBase);
      if (firstByte === 0xFF) continue;

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

  // ── Serialise back to ArrayBuffer ─────────────────────────────────────────────
  toArrayBuffer() {
    return this.buf.slice(0);
  }

  // ── Factory ──────────────────────────────────────────────────────────────────
  static async fromFile(file) {
    const buf = await file.arrayBuffer();
    const parser = new CodeplugParser(buf);
    parser.filename = file.name;
    return parser;
  }
}
