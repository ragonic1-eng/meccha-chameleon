// Convert the classroom FBX meshes we need into web GLBs, resolve their textures
// by Unity's naming convention, copy them, and emit a manifest the client reads.
//
//   node tools/build_map.mjs
//
// Requires the unitypackage to have been extracted first:
//   python tools/extract_unitypackage.py <pkg> tools/_extracted
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import convert from "fbx2gltf";
import sharp from "sharp";

const TEX_MAX = 512; // downscale textures for mobile (source are ~2K)

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(root, "tools/_extracted/Assets/JP_School classroom_V2");
const MESHES = path.join(SRC, "Meshes");
const TEX = path.join(SRC, "Textures");
const OUT = path.join(root, "client/public/maps/classroom");
const OUT_TEX = path.join(OUT, "textures");

// meshes to ship in the playable map (shell + key furniture)
const WANT = [
  "classroom01_8x10x3.5m",
  "desk01",
  "chair01",
  "blackboard01_1",
  "board01_long",
  "platform01",
  "locker01_close",
  "window01",
  "door01_A",
  "clock01",
];

async function listTextures() {
  const files = await fs.readdir(TEX);
  return new Set(files);
}

/** Resolve albedo + normal texture filenames for a GLB material name. */
function resolveTextures(matName, texSet) {
  const albedoCandidates = [`${matName}_1.png`, `${matName}.png`, `${matName}_2.png`];
  const albedo = albedoCandidates.find((f) => texSet.has(f)) || null;
  // normal: strip a trailing _<digit> from the material name, then _NRM.png
  const base = matName.replace(/_\d+$/, "");
  const nrmCandidates = [`${matName}_NRM.png`, `${base}_NRM.png`];
  const normal = nrmCandidates.find((f) => texSet.has(f)) || null;
  return { albedo, normal };
}

function readGlbJson(buf) {
  const clen = buf.readUInt32LE(12);
  return JSON.parse(buf.slice(20, 20 + clen).toString("utf8"));
}

async function main() {
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT_TEX, { recursive: true });
  const texSet = await listTextures();
  const albedoSet = new Set();
  const normalSet = new Set();
  const manifest = { meshes: {} };

  for (const name of WANT) {
    const fbx = path.join(MESHES, `${name}.fbx`);
    try {
      await fs.access(fbx);
    } catch {
      console.warn(`skip ${name}: no fbx`);
      continue;
    }
    const glb = path.join(OUT, `${name}.glb`);
    await convert(fbx, glb, ["--khr-materials-unlit"]).catch((e) => {
      throw new Error(`convert ${name}: ${e}`);
    });
    const json = readGlbJson(await fs.readFile(glb));
    const mats = {};
    for (const m of json.materials || []) {
      const { albedo, normal } = resolveTextures(m.name, texSet);
      if (albedo) albedoSet.add(albedo);
      if (normal) normalSet.add(normal);
      mats[m.name] = { albedo, normal };
    }
    manifest.meshes[name] = { file: `${name}.glb`, materials: mats };
    console.log(`✓ ${name}.glb  materials=${Object.keys(mats).length}`);
  }

  // albedo → downscaled JPG (rename .png→.jpg); normal → downscaled PNG
  const rename = {};
  for (const f of albedoSet) {
    const out = f.replace(/\.png$/i, ".jpg");
    await sharp(path.join(TEX, f)).resize(TEX_MAX, TEX_MAX, { fit: "inside" }).jpeg({ quality: 82 }).toFile(path.join(OUT_TEX, out));
    rename[f] = out;
  }
  for (const f of normalSet) {
    await sharp(path.join(TEX, f)).resize(TEX_MAX, TEX_MAX, { fit: "inside" }).png({ compressionLevel: 9 }).toFile(path.join(OUT_TEX, f));
  }
  // point manifest albedo entries at the new .jpg filenames
  for (const mesh of Object.values(manifest.meshes)) {
    for (const mat of Object.values(mesh.materials)) {
      if (mat.albedo && rename[mat.albedo]) mat.albedo = rename[mat.albedo];
    }
  }
  await fs.writeFile(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`\nmap built: ${Object.keys(manifest.meshes).length} meshes, ${albedoSet.size} albedo + ${normalSet.size} normal textures → ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
