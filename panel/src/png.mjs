// A minimal PNG encoder for demo wireframes: RGB, 8-bit, no interlace.
// Demo evidence is generated, never copied from a real project.
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

export class Canvas {
  constructor(width, height, background = [255, 255, 255]) {
    this.width = width;
    this.height = height;
    this.pixels = Buffer.alloc(width * height * 3);
    this.rect(0, 0, width, height, background);
  }

  rect(x, y, w, h, [r, g, b], radius = 0) {
    for (let j = Math.max(0, y); j < Math.min(this.height, y + h); j += 1) {
      for (let i = Math.max(0, x); i < Math.min(this.width, x + w); i += 1) {
        if (radius > 0) {
          const dx = Math.max(x + radius - i - 0.5, 0, i + 0.5 - (x + w - radius));
          const dy = Math.max(y + radius - j - 0.5, 0, j + 0.5 - (y + h - radius));
          if (dx * dx + dy * dy > radius * radius) continue;
        }
        const offset = (j * this.width + i) * 3;
        this.pixels[offset] = r;
        this.pixels[offset + 1] = g;
        this.pixels[offset + 2] = b;
      }
    }
    return this;
  }

  png() {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(this.width, 0);
    header.writeUInt32BE(this.height, 4);
    header[8] = 8; // bit depth
    header[9] = 2; // RGB
    const raw = Buffer.alloc((this.width * 3 + 1) * this.height);
    for (let y = 0; y < this.height; y += 1) {
      raw[y * (this.width * 3 + 1)] = 0;
      this.pixels.copy(raw, y * (this.width * 3 + 1) + 1, y * this.width * 3, (y + 1) * this.width * 3);
    }
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      chunk('IDAT', zlib.deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  }
}
