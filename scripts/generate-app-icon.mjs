import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";

const outDir = path.resolve("src", "assets");
const pngPath = path.join(outDir, "app-icon.png");
const icoPath = path.join(outDir, "app-icon.ico");
const icoSizes = [16, 32, 48, 64, 128, 256];
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

await fs.mkdir(outDir, { recursive: true });
await fs.writeFile(pngPath, encodePng(1024, 1024, renderIcon(1024)));

const icoEntries = icoSizes.map((size) => ({
  size,
  png: encodePng(size, size, renderIcon(size))
}));
await fs.writeFile(icoPath, encodeIco(icoEntries));

console.log(
  JSON.stringify(
    {
      ok: true,
      png: pngPath,
      ico: icoPath,
      sizes: icoSizes
    },
    null,
    2
  )
);

function renderIcon(size) {
  const data = Buffer.alloc(size * size * 4);
  const aa = size >= 128 ? 3 : 4;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let sa = 0;
      const samples = aa * aa;

      for (let sy = 0; sy < aa; sy += 1) {
        for (let sx = 0; sx < aa; sx += 1) {
          const x = (px + (sx + 0.5) / aa) / size;
          const y = (py + (sy + 0.5) / aa) / size;
          const c = sampleIcon(x, y, size);
          sr += c[0];
          sg += c[1];
          sb += c[2];
          sa += c[3];
        }
      }

      const i = (py * size + px) * 4;
      data[i] = Math.round(sr / samples);
      data[i + 1] = Math.round(sg / samples);
      data[i + 2] = Math.round(sb / samples);
      data[i + 3] = Math.round(sa / samples);
    }
  }

  return data;
}

function sampleIcon(x, y, size) {
  let pixel = [0, 0, 0, 0];
  const edge = 1.35 / size;

  const wPath = [
    [0.16, 0.59],
    [0.27, 0.75],
    [0.42, 0.38],
    [0.56, 0.75],
    [0.73, 0.35],
    [0.83, 0.58]
  ];

  const shadowW = strokeAlpha(x - 0.018, y - 0.026, wPath, 0.116, edge * 4);
  pixel = over(pixel, [15, 12, 34, Math.round(58 * shadowW)]);

  const glowW = strokeAlpha(x, y, wPath, 0.138, edge * 8);
  pixel = over(pixel, [43, 215, 187, Math.round(24 * glowW)]);

  const wAlpha = strokeAlpha(x, y, wPath, 0.096, edge * 1.5);
  if (wAlpha > 0) {
    const t = clamp((x - 0.14) / 0.74, 0, 1);
    const base = mixColor([35, 31, 95], [27, 185, 170], t);
    const lit = mixColor(base, [246, 210, 116], clamp((0.72 - y) * 0.7, 0, 0.32));
    pixel = over(pixel, [...lit, Math.round(255 * wAlpha)]);
  }

  const wHighlight = strokeAlpha(x, y + 0.018, wPath, 0.022, edge * 1.4);
  pixel = over(pixel, [255, 255, 255, Math.round(52 * wHighlight)]);

  const nib = [
    [0.58, 0.31],
    [0.71, 0.18],
    [0.86, 0.34],
    [0.70, 0.53]
  ];
  const nibShadow = polygonAlpha(x - 0.016, y - 0.024, nib, edge * 5);
  pixel = over(pixel, [17, 13, 31, Math.round(64 * nibShadow)]);

  const nibAlpha = polygonAlpha(x, y, nib, edge * 1.5);
  if (nibAlpha > 0) {
    const t = clamp((x + y - 0.78) / 0.35, 0, 1);
    const gold = mixColor([251, 226, 153], [213, 143, 45], t);
    pixel = over(pixel, [...gold, Math.round(255 * nibAlpha)]);
  }

  const split = strokeAlpha(x, y, [[0.69, 0.28], [0.71, 0.44]], 0.012, edge * 1.4);
  pixel = over(pixel, [42, 36, 83, Math.round(180 * split)]);

  const breather = circleAlpha(x, y, 0.705, 0.335, 0.026, edge * 1.5);
  pixel = over(pixel, [42, 36, 83, Math.round(210 * breather)]);

  const tip = polygonAlpha(
    x,
    y,
    [
      [0.58, 0.31],
      [0.64, 0.42],
      [0.70, 0.53]
    ],
    edge * 1.5
  );
  pixel = over(pixel, [255, 245, 200, Math.round(96 * tip)]);

  const ink = circleAlpha(x, y, 0.20, 0.52, 0.032, edge * 2);
  pixel = over(pixel, [29, 183, 169, Math.round(170 * ink)]);

  return pixel;
}

function strokeAlpha(x, y, points, width, feather) {
  let d = Infinity;
  for (let i = 0; i < points.length - 1; i += 1) {
    d = Math.min(d, distanceToSegment(x, y, points[i], points[i + 1]));
  }
  return smooth(width / 2 + feather, width / 2 - feather, d);
}

function polygonAlpha(x, y, points, feather) {
  const inside = pointInPolygon(x, y, points);
  let d = Infinity;
  for (let i = 0; i < points.length; i += 1) {
    d = Math.min(d, distanceToSegment(x, y, points[i], points[(i + 1) % points.length]));
  }
  return inside ? 1 : smooth(feather, 0, d);
}

function circleAlpha(x, y, cx, cy, radius, feather) {
  const d = Math.hypot(x - cx, y - cy);
  return smooth(radius + feather, radius - feather, d);
}

function distanceToSegment(x, y, a, b) {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const wx = x - a[0];
  const wy = y - a[1];
  const c1 = vx * wx + vy * wy;
  const c2 = vx * vx + vy * vy;
  const t = c2 === 0 ? 0 : clamp(c1 / c2, 0, 1);
  return Math.hypot(x - (a[0] + t * vx), y - (a[1] + t * vy));
}

function pointInPolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const xi = points[i][0];
    const yi = points[i][1];
    const xj = points[j][0];
    const yj = points[j][1];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) {
      inside = !inside;
    }
  }
  return inside;
}

function over(dst, src) {
  const sa = src[3] / 255;
  const da = dst[3] / 255;
  const outA = sa + da * (1 - sa);
  if (outA <= 0) {
    return [0, 0, 0, 0];
  }
  return [
    Math.round((src[0] * sa + dst[0] * da * (1 - sa)) / outA),
    Math.round((src[1] * sa + dst[1] * da * (1 - sa)) / outA),
    Math.round((src[2] * sa + dst[2] * da * (1 - sa)) / outA),
    Math.round(outA * 255)
  ];
}

function mixColor(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t)
  ];
}

function smooth(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function encodePng(width, height, rgba) {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    raw[row] = 0;
    rgba.copy(raw, row + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", packIhdr(width, height)),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function packIhdr(width, height) {
  const buffer = Buffer.alloc(13);
  buffer.writeUInt32BE(width, 0);
  buffer.writeUInt32BE(height, 4);
  buffer[8] = 8;
  buffer[9] = 6;
  buffer[10] = 0;
  buffer[11] = 0;
  buffer[12] = 0;
  return buffer;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  let offset = 6 + entries.length * 16;
  const directory = [];
  const payloads = [];

  for (const entry of entries) {
    const row = Buffer.alloc(16);
    row[0] = entry.size === 256 ? 0 : entry.size;
    row[1] = entry.size === 256 ? 0 : entry.size;
    row[2] = 0;
    row[3] = 0;
    row.writeUInt16LE(1, 4);
    row.writeUInt16LE(32, 6);
    row.writeUInt32LE(entry.png.length, 8);
    row.writeUInt32LE(offset, 12);
    offset += entry.png.length;
    directory.push(row);
    payloads.push(entry.png);
  }

  return Buffer.concat([header, ...directory, ...payloads]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}
