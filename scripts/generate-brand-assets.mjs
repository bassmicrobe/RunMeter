import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = new URL("../", import.meta.url);
const source = await readFile(new URL("public/brand/runmeter-appicon.svg", root));

async function png(size) {
  return sharp(source, { density: 384 }).resize(size, size).png().toBuffer();
}

async function ico(sizes) {
  const images = await Promise.all(sizes.map(png));
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, index) => {
    const entry = 6 + index * 16;
    header.writeUInt8(size === 256 ? 0 : size, entry);
    header.writeUInt8(size === 256 ? 0 : size, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(images[index].length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += images[index].length;
  });
  return Buffer.concat([header, ...images]);
}

// macOS app icon: each entry is a PNG tagged with its ICNS type.
async function icns(entries) {
  const images = await Promise.all(entries.map(async ([type, size]) => {
    const data = await png(size);
    const header = Buffer.alloc(8);
    header.write(type, 0, "ascii");
    header.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([header, data]);
  }));
  const header = Buffer.alloc(8);
  header.write("icns", 0, "ascii");
  header.writeUInt32BE(8 + images.reduce((total, image) => total + image.length, 0), 4);
  return Buffer.concat([header, ...images]);
}

// The macOS menu bar tints template images itself, so only the mark's shape
// is kept: black with the inactive track at reduced opacity.
const mark = (await readFile(new URL("public/brand/runmeter-mark-mono.svg", root), "utf8"))
  .replace('stroke="#d5d8da"', 'stroke="#000" stroke-opacity=".35"')
  .replaceAll("#14171a", "#000");
async function template(size) {
  return sharp(Buffer.from(mark), { density: 384 }).resize(size, size).png().toBuffer();
}

const [icon, apple, favicon, windowsIcon, macIcon, trayIcon, trayIcon2x, logo] = await Promise.all([
  png(512), png(180), ico([16, 32, 48, 64]), ico([16, 24, 32, 48, 64, 128, 256]),
  icns([["icp4", 16], ["icp5", 32], ["ic11", 32], ["ic12", 64], ["ic07", 128], ["ic08", 256],
    ["ic13", 256], ["ic09", 512], ["ic14", 512], ["ic10", 1024]]),
  template(18), template(36),
  readFile(new URL("public/brand/runmeter-logo-dark.svg", root)),
]);
const assets = [
  ["src/app/icon.png", icon],
  ["src/app/apple-icon.png", apple],
  ["src/app/favicon.ico", favicon],
  ["desktop/assets/runmeter.png", icon],
  ["desktop/assets/runmeter.ico", windowsIcon],
  ["desktop/assets/runmeter.icns", macIcon],
  ["desktop/assets/runmeterTemplate.png", trayIcon],
  ["desktop/assets/runmeterTemplate@2x.png", trayIcon2x],
  ["desktop/assets/runmeter-logo.svg", logo],
];
await Promise.all(assets.map(([path, contents]) => writeFile(new URL(path, root), contents)));
console.log(`Generated ${assets.length} brand assets from the supplied SVG artwork.`);
console.log(`Source: ${fileURLToPath(new URL("public/brand/runmeter-appicon.svg", root)).split(/[\\/]/).slice(-3).join("/")}`);
