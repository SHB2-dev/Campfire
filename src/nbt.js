// Minecraft Java Edition の NBT(圧縮なし)の読み書き。servers.dat の編集用。
// 読んだ内容を、そのまま同じバイト列で書き戻せること(往復しても何も失わないこと)を重視している。
//
// 表現: タグは { type, value }。
//   compound: value = [{ name, tag }...](順序を保つ) / list: value = { itemType, items: [値...] }
//   long: 8バイトの Buffer(精度を落とさないため) / byteArray・intArray・longArray: Buffer か 配列
const T = { END: 0, BYTE: 1, SHORT: 2, INT: 3, LONG: 4, FLOAT: 5, DOUBLE: 6, BYTE_ARRAY: 7, STRING: 8, LIST: 9, COMPOUND: 10, INT_ARRAY: 11, LONG_ARRAY: 12 };

// ---- Java の「修正UTF-8」(NUL は C0 80、補助文字はサロゲートペアを3バイトずつ) ----
function decodeModifiedUtf8(buf) {
  let out = '';
  for (let i = 0; i < buf.length;) {
    const a = buf[i++];
    if (a < 0x80) out += String.fromCharCode(a);
    else if ((a & 0xe0) === 0xc0) out += String.fromCharCode(((a & 0x1f) << 6) | (buf[i++] & 0x3f));
    else out += String.fromCharCode(((a & 0x0f) << 12) | ((buf[i++] & 0x3f) << 6) | (buf[i++] & 0x3f));
  }
  return out;
}
function encodeModifiedUtf8(str) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c !== 0 && c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return Buffer.from(bytes);
}

// ---- 読み込み ----
function readTag(r, type) {
  switch (type) {
    case T.BYTE: { const v = r.buf.readInt8(r.pos); r.pos += 1; return v; }
    case T.SHORT: { const v = r.buf.readInt16BE(r.pos); r.pos += 2; return v; }
    case T.INT: { const v = r.buf.readInt32BE(r.pos); r.pos += 4; return v; }
    case T.LONG: { const v = Buffer.from(r.buf.subarray(r.pos, r.pos + 8)); r.pos += 8; return v; }
    case T.FLOAT: { const v = r.buf.readFloatBE(r.pos); r.pos += 4; return v; }
    case T.DOUBLE: { const v = r.buf.readDoubleBE(r.pos); r.pos += 8; return v; }
    case T.BYTE_ARRAY: { const n = r.buf.readInt32BE(r.pos); r.pos += 4; const v = Buffer.from(r.buf.subarray(r.pos, r.pos + n)); r.pos += n; return v; }
    case T.STRING: return readString(r);
    case T.LIST: {
      const itemType = r.buf.readUInt8(r.pos); const n = r.buf.readInt32BE(r.pos + 1); r.pos += 5;
      const items = [];
      for (let i = 0; i < n; i++) items.push(readTag(r, itemType));
      return { itemType, items };
    }
    case T.COMPOUND: {
      const entries = [];
      for (;;) {
        const t = r.buf.readUInt8(r.pos++);
        if (t === T.END) break;
        const name = readString(r);
        entries.push({ name, tag: { type: t, value: readTag(r, t) } });
      }
      return entries;
    }
    case T.INT_ARRAY: { const n = r.buf.readInt32BE(r.pos); r.pos += 4; const v = Buffer.from(r.buf.subarray(r.pos, r.pos + n * 4)); r.pos += n * 4; return v; }
    case T.LONG_ARRAY: { const n = r.buf.readInt32BE(r.pos); r.pos += 4; const v = Buffer.from(r.buf.subarray(r.pos, r.pos + n * 8)); r.pos += n * 8; return v; }
    default: throw new Error(`未知のNBTタグ: ${type}`);
  }
}
function readString(r) {
  const n = r.buf.readUInt16BE(r.pos); r.pos += 2;
  const s = decodeModifiedUtf8(r.buf.subarray(r.pos, r.pos + n)); r.pos += n;
  return s;
}

// 戻り値: { name, tag }(ルートのタグ)
function parse(buf) {
  const r = { buf, pos: 0 };
  const type = buf.readUInt8(r.pos++);
  if (type !== T.COMPOUND) throw new Error('NBTのルートが compound ではありません');
  const name = readString(r);
  const value = readTag(r, type);
  return { name, tag: { type, value } };
}

// ---- 書き込み ----
const w8 = (n) => Buffer.from([n & 0xff]);
const w16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const wi32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
function writeString(s) { const e = encodeModifiedUtf8(s); if (e.length > 0xffff) throw new Error('文字列が長すぎます'); return Buffer.concat([w16(e.length), e]); }

function writeTag(type, value) {
  switch (type) {
    case T.BYTE: { const b = Buffer.alloc(1); b.writeInt8(value); return b; }
    case T.SHORT: { const b = Buffer.alloc(2); b.writeInt16BE(value); return b; }
    case T.INT: return wi32(value);
    case T.LONG: return Buffer.from(value);
    case T.FLOAT: { const b = Buffer.alloc(4); b.writeFloatBE(value); return b; }
    case T.DOUBLE: { const b = Buffer.alloc(8); b.writeDoubleBE(value); return b; }
    case T.BYTE_ARRAY: return Buffer.concat([wi32(value.length), value]);
    case T.STRING: return writeString(value);
    case T.LIST: return Buffer.concat([w8(value.itemType), wi32(value.items.length), ...value.items.map((v) => writeTag(value.itemType, v))]);
    case T.COMPOUND: return Buffer.concat([...value.map(({ name, tag }) => Buffer.concat([w8(tag.type), writeString(name), writeTag(tag.type, tag.value)])), w8(T.END)]);
    case T.INT_ARRAY: return Buffer.concat([wi32(value.length / 4), value]);
    case T.LONG_ARRAY: return Buffer.concat([wi32(value.length / 8), value]);
    default: throw new Error(`未知のNBTタグ: ${type}`);
  }
}

function write(root) {
  return Buffer.concat([w8(root.tag.type), writeString(root.name), writeTag(root.tag.type, root.tag.value)]);
}

module.exports = { T, parse, write };
