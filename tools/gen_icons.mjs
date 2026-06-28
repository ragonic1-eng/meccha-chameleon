// Generate PWA icons from an inline SVG (chameleon eye + paint drop on brand gradient).
import sharp from "sharp";
import path from "path";
import { fileURLToPath } from "url";
import { promises as fs } from "fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(root, "client/public/icons");

function svg(pad) {
  const m = pad; // safe-area margin for maskable
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#74e08a"/>
      <stop offset="1" stop-color="#4aa3e0"/>
    </linearGradient>
  </defs>
  <rect x="${m}" y="${m}" width="${512 - m * 2}" height="${512 - m * 2}" rx="96" fill="url(#g)"/>
  <!-- chameleon turret eye -->
  <circle cx="256" cy="232" r="118" fill="#0e1512" opacity="0.18"/>
  <circle cx="256" cy="232" r="100" fill="#fdfdfb"/>
  <circle cx="256" cy="232" r="52" fill="#2a7d3e"/>
  <circle cx="256" cy="232" r="22" fill="#0e1512"/>
  <circle cx="278" cy="214" r="9" fill="#fff"/>
  <!-- paint drop -->
  <path d="M256 350 C300 396 318 420 318 446 a62 62 0 0 1 -124 0 C194 420 212 396 256 350 Z" fill="#ffd34d"/>
</svg>`;
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  await sharp(Buffer.from(svg(0))).resize(192, 192).png().toFile(path.join(OUT, "icon-192.png"));
  await sharp(Buffer.from(svg(0))).resize(512, 512).png().toFile(path.join(OUT, "icon-512.png"));
  // maskable variant with safe padding
  await sharp(Buffer.from(svg(40))).resize(512, 512).png().toFile(path.join(OUT, "icon-maskable-512.png"));
  await sharp(Buffer.from(svg(0))).resize(180, 180).png().toFile(path.join(OUT, "apple-touch-icon.png"));
  console.log("icons written to", OUT);
}
main().catch((e) => { console.error(e); process.exit(1); });
