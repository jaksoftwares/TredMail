/**
 * Builds the console's icons and logo files from the official Dovepeak brand kit in
 * /branding. Every asset is derived from a kit file; nothing is redrawn.
 *
 *   npm run brand:assets   (from apps/console)
 *
 * Re-run it whenever the brand kit changes, then commit the output.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const consoleDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const kit = join(consoleDir, "..", "..", "branding", "LOGO & VARIATIONS");
const appDir = join(consoleDir, "src", "app");
const brandDir = join(consoleDir, "public", "brand");

const NAVY = "#000027";
const OFF_WHITE = "#f8f8ff";

const kitFile = (...parts) => readFile(join(kit, ...parts), "utf8");

// Kit sources
const faviconLight = await kitFile("FAVICONS", "SVG_S", "__1.svg"); // navy + orange, transparent
const faviconTile = await kitFile("FAVICONS", "SVG_S", "__2.svg"); // off-white + orange on a navy tile
const brandmark = await kitFile("BRANDMARK", "SVG_S", "__BRANDMARK_1.svg"); // navy + orange, transparent
const brandmarkTile = await kitFile("BRANDMARK", "SVG_S", "__BRANDMARK_2.svg"); // off-white + orange on navy
const logo = await kitFile("PRIMARY LOGO", "SVG_S", "__MAIN LOGO_VARIATION 1.svg"); // for light backgrounds
const logoTile = await kitFile("PRIMARY LOGO", "SVG_S", "__MAIN LOGO_VARIATION  2.svg"); // for navy backgrounds

/** Drops the kit's full-bleed background so a mark can sit on any navy surface. */
const withoutBackground = (svg) => svg.replace(/<rect\b[^>]*\/>\s*/, "");

/**
 * The tab icon: the kit's navy favicon, switching its navy strokes to off-white (the kit's
 * on-dark favicon colours) when the browser chrome is dark, so it never disappears.
 */
const adaptiveFavicon = faviconLight.replace(
  "</style>",
  `  @media (prefers-color-scheme: dark) {\n        .cls-2 {\n          fill: ${OFF_WHITE};\n        }\n      }\n    </style>`,
);
if (adaptiveFavicon === faviconLight) throw new Error("favicon kit file changed shape; update the dark-mode swap");

const brandmarkOnDark = withoutBackground(brandmarkTile);
const logoOnDark = withoutBackground(logoTile);

/** Renders an SVG to a PNG buffer at the given width. */
const png = (svg, width) => sharp(Buffer.from(svg), { density: 600 }).resize({ width }).png().toBuffer();

/** The on-dark brandmark centred on a navy square, the mark filling `scale` of the height. */
async function navyTile(size, scale) {
  const markHeight = Math.round(size * scale);
  const mark = await sharp(Buffer.from(brandmarkOnDark), { density: 600 }).resize({ height: markHeight }).png().toBuffer();
  return sharp({ create: { width: size, height: size, channels: 4, background: NAVY } })
    .composite([{ input: mark, gravity: "centre" }])
    .png()
    .toBuffer();
}

/** Packs PNG images into one .ico file (PNG-compressed entries, supported since Windows Vista). */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const entries = images.map(({ size, data }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

await mkdir(brandDir, { recursive: true });

// Browser and device icons (Next.js metadata file conventions in src/app)
await writeFile(join(appDir, "icon.svg"), adaptiveFavicon);
const icoSizes = [16, 32, 48];
const icoImages = await Promise.all(
  icoSizes.map(async (size) => ({
    size,
    data: await sharp(Buffer.from(faviconTile), { density: 600 })
      .resize(size, size, { fit: "contain", background: NAVY })
      .png()
      .toBuffer(),
  })),
);
await writeFile(join(appDir, "favicon.ico"), ico(icoImages));
await writeFile(join(appDir, "apple-icon.png"), await navyTile(180, 0.62));

// Open Graph card: the on-dark primary logo on navy, used when a console link is shared
const card = await png(logoOnDark, 760);
await writeFile(
  join(appDir, "opengraph-image.png"),
  await sharp({ create: { width: 1200, height: 630, channels: 4, background: NAVY } })
    .composite([{ input: card, gravity: "centre" }])
    .png()
    .toBuffer(),
);

// Web app manifest icons (the maskable one keeps the mark inside the 80% safe zone)
await writeFile(join(brandDir, "icon-192.png"), await navyTile(192, 0.62));
await writeFile(join(brandDir, "icon-512.png"), await navyTile(512, 0.62));
await writeFile(join(brandDir, "icon-maskable-512.png"), await navyTile(512, 0.5));

// Logos used by the console UI
await writeFile(join(brandDir, "brandmark.svg"), brandmark);
await writeFile(join(brandDir, "brandmark-on-dark.svg"), brandmarkOnDark);
await writeFile(join(brandDir, "dovepeak-logo.svg"), logo);

// Raster logos for account emails (mail clients do not render SVG). 2x for sharp displays.
await writeFile(join(brandDir, "email-brandmark-on-dark.png"), await png(brandmarkOnDark, 72));
await writeFile(join(brandDir, "email-dovepeak-logo.png"), await png(logo, 280));

console.log("Brand assets written to src/app and public/brand");
