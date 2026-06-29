// Procedural multi-room school level — the single source of truth for the building's
// architecture (walls), blocking furniture (colliders) and spawns. The CLIENT renders
// walls from the exact same WALLS array it collides against, so what you see is what
// blocks you (this is what fixes "players can pass through walls"). The SERVER imports
// the same COLLIDERS/SPAWNS/resolveMovement, so client + server agree on movement.
//
// Coords: engine RH, floor y=0, building centred on origin. X = east/west, Z = north/south.
//
// Layout (a real little school, 3 room bands joined by 2 hallways + a central spine):
//
//        N band:  classroom │ messy class │ art room        (3 rooms)
//   ── corridor A ───────────────────────────────────────────
//        M band:  library  │▓ spine ▓│  science lab          (2 rooms + central corridor)
//   ── corridor B ───────────────────────────────────────────
//        S band:  music room │ gymnasium                     (2 rooms)
//
// The two east-west corridors are linked by the central north-south "spine" (the gap
// between the two middle rooms), so the whole building is one connected loop.

export type Theme = "classroom" | "messy" | "art" | "library" | "lab" | "music" | "gym";

export interface RoomDef {
  id: string;
  theme: Theme;
  cx: number; cz: number; // centre
  w: number; d: number;   // interior width (x) / depth (z)
  side: "north" | "south";
  boardZ: number;         // z of the wall the board hangs on (the room's "front")
  door: { x: number; z: number; w: number }; // doorway centre on the corridor wall
}

export interface WallSeg { x1: number; z1: number; x2: number; z2: number; } // axis-aligned
export interface DoorDef { x: number; z: number; w: number; horizontal: boolean; }
export interface PropDef { mesh: string; x: number; z: number; ry: number; s: number; r: number; theme?: Theme; kind?: string; }

// ---- dimensions (metres) ----
export const PLAYER_RADIUS = 0.26;
export const WALL_T = 0.14;          // wall thickness
const HT = WALL_T / 2;               // wall half-thickness (collision)
export const WALL_H = 3.2;           // wall / ceiling height
export const DOOR_W = 1.5;
export const DOOR_H = 2.15;

const RD = 7.0;                      // room depth (each band)
const HX = 9.9;                      // building half-width  (X ∈ [-9.9, 9.9])
const CH = 1.5;                      // corridor half-depth  (corridors are 3.0m deep)
const CW = 1.5;                      // central spine half-width (3.0m wide)

// z lines, north (−) to south (+). Middle band is centred on z=0.
const MID_HALF = RD / 2;             // 3.5  — middle band spans z ∈ [-3.5, 3.5]
const zAs = -MID_HALF;               // -3.5  corridor A south wall  / middle band north wall
const zAn = zAs - 2 * CH;            // -6.5  corridor A north wall  / north band south wall
const zBn = MID_HALF;                //  3.5  corridor B north wall  / middle band south wall
const zBs = zBn + 2 * CH;            //  6.5  corridor B south wall  / south band north wall
const zNouter = zAn - RD;            // -13.5 north outer wall
const zSouter = zBs + RD;            //  13.5 south outer wall
const HZ = -zNouter;                 //  13.5 building half-depth

const NZ = (zNouter + zAn) / 2;      // -10.0 north band centre z
const SZ = (zBs + zSouter) / 2;      //  10.0 south band centre z

export const ROOM = {
  minX: -HX, maxX: HX, minZ: -HZ, maxZ: HZ,
  halfX: HX, halfZ: HZ, eyeStand: 1.45,
};

// north band: 3 columns (6.6m). south band: 2 columns (9.9m).
// middle band: 2 rooms flanking the central spine (each 8.4m).
const NW = (2 * HX) / 3;             // 6.6
const SW = (2 * HX) / 2;             // 9.9
const MW = HX - CW;                  // 8.4 — middle room width
const nCx = [-NW, 0, NW];           // -6.6, 0, 6.6
const sCx = [-SW / 2, SW / 2];      // -4.95, 4.95
const mCx = [-(CW + MW / 2), CW + MW / 2]; // -5.7, 5.7

export const ROOMS: RoomDef[] = [
  // north band — opens south onto corridor A
  { id: "n0", theme: "classroom", cx: nCx[0], cz: NZ, w: NW, d: RD, side: "north", boardZ: zNouter, door: { x: nCx[0], z: zAn, w: DOOR_W } },
  { id: "n1", theme: "messy",     cx: nCx[1], cz: NZ, w: NW, d: RD, side: "north", boardZ: zNouter, door: { x: nCx[1], z: zAn, w: DOOR_W } },
  { id: "n2", theme: "art",       cx: nCx[2], cz: NZ, w: NW, d: RD, side: "north", boardZ: zNouter, door: { x: nCx[2], z: zAn, w: DOOR_W } },
  // middle band — board on the south wall, door north onto corridor A; east/west walls face the spine
  { id: "m0", theme: "library",   cx: mCx[0], cz: 0,  w: MW, d: RD, side: "south", boardZ: zBn, door: { x: mCx[0], z: zAs, w: DOOR_W } },
  { id: "m1", theme: "lab",       cx: mCx[1], cz: 0,  w: MW, d: RD, side: "south", boardZ: zBn, door: { x: mCx[1], z: zAs, w: DOOR_W } },
  // south band — opens north onto corridor B
  { id: "s0", theme: "music",     cx: sCx[0], cz: SZ, w: SW, d: RD, side: "south", boardZ: zSouter, door: { x: sCx[0], z: zBs, w: DOOR_W } },
  { id: "s1", theme: "gym",       cx: sCx[1], cz: SZ, w: SW, d: RD, side: "south", boardZ: zSouter, door: { x: sCx[1], z: zBs, w: DOOR_W } },
];

// ---------------------------------------------------------------------------
// WALLS + DOORS — generated once. A wall line is split into solid segments
// around its door gaps. Doors are recorded separately (for lintels / jamb posts).
// ---------------------------------------------------------------------------
export const WALLS: WallSeg[] = [];
export const DOORS: DoorDef[] = [];

function splitLine(from: number, to: number, gaps: { c: number; w: number }[]): [number, number][] {
  const segs: [number, number][] = [];
  let cursor = from;
  for (const g of [...gaps].sort((a, b) => a.c - b.c)) {
    const gs = g.c - g.w / 2, ge = g.c + g.w / 2;
    if (gs > cursor + 0.001) segs.push([cursor, gs]);
    cursor = Math.max(cursor, ge);
  }
  if (to > cursor + 0.001) segs.push([cursor, to]);
  return segs;
}

function hWall(z: number, x0: number, x1: number, gaps: { c: number; w: number }[] = []) {
  for (const [a, b] of splitLine(x0, x1, gaps)) WALLS.push({ x1: a, z1: z, x2: b, z2: z });
  for (const g of gaps) DOORS.push({ x: g.c, z, w: g.w, horizontal: true });
}
function vWall(x: number, z0: number, z1: number, gaps: { c: number; w: number }[] = []) {
  for (const [a, b] of splitLine(z0, z1, gaps)) WALLS.push({ x1: x, z1: a, x2: x, z2: b });
  for (const g of gaps) DOORS.push({ x, z: g.c, w: g.w, horizontal: false });
}

// outer perimeter
hWall(zNouter, -HX, HX);
hWall(zSouter, -HX, HX);
vWall(-HX, zNouter, zSouter);
vWall(HX, zNouter, zSouter);

// corridor A north wall (= north rooms' south wall) — one doorway per north room
hWall(zAn, -HX, HX, nCx.map((c) => ({ c, w: DOOR_W })));
// corridor A south wall (= middle rooms' north wall) — solid only where the middle
// rooms are; the centre (|x|<CW) is the open spine. Each middle room gets a doorway.
hWall(zAs, -HX, -CW, [{ c: mCx[0], w: DOOR_W }]);
hWall(zAs, CW, HX, [{ c: mCx[1], w: DOOR_W }]);
// corridor B north wall (= middle rooms' south wall) — solid sides, open spine, no doors
hWall(zBn, -HX, -CW);
hWall(zBn, CW, HX);
// corridor B south wall (= south rooms' north wall) — one doorway per south room
hWall(zBs, -HX, HX, sCx.map((c) => ({ c, w: DOOR_W })));

// north band dividers (north outer → corridor A)
vWall(nCx[0] + NW / 2, zNouter, zAn); // x=-3.3
vWall(nCx[1] + NW / 2, zNouter, zAn); // x= 3.3
// central spine walls (the inner faces of the two middle rooms)
vWall(-CW, zAs, zBn);
vWall(CW, zAs, zBn);
// south band divider (corridor B → south outer)
vWall(0, zBs, zSouter);

// ---------------------------------------------------------------------------
// FURNITURE — blocking props (desks/shelves/lockers/counters) authored per room.
// Each entry can render a GLB (mesh!=""), contribute a collider (r>0), or both.
// The CLIENT clones `mesh` at (x,z,ry,s); the SERVER turns r>0 entries into COLLIDERS.
// Small clutter (books, drawings, knocked chairs) is client-only decoration.
// ---------------------------------------------------------------------------
export const FURNITURE: PropDef[] = [];
const put = (mesh: string, x: number, z: number, ry: number, theme: Theme, kind = "", s = 1) =>
  FURNITURE.push({ mesh, x, z, ry, s, r: 0, theme, kind });
const furn = (mesh: string, x: number, z: number, ry: number, r: number, theme: Theme, kind = "", s = 1) =>
  FURNITURE.push({ mesh, x, z, ry, s, r, theme, kind });
const block = (x: number, z: number, r: number, theme: Theme) =>
  FURNITURE.push({ mesh: "", x, z, ry: 0, s: 1, r, theme });

// student desk grid facing the board. `jit` adds messy offsets/rotation hints (client).
function deskGrid(rm: RoomDef, cols: number, rows: number, jit = 0) {
  const front = rm.boardZ + (rm.side === "north" ? 1.5 : -1.5); // first row near board
  const dz = rm.side === "north" ? 1.55 : -1.55;                // step toward the door
  const faceBoard = rm.side === "north" ? Math.PI : 0;
  const colGap = rm.w / (cols + 1);
  for (let c = 0; c < cols; c++) {
    const x0 = rm.cx - rm.w / 2 + colGap * (c + 1);
    for (let r = 0; r < rows; r++) {
      const seed = Math.sin((c + 1) * 12.9 + (r + 1) * 78.2) * 43758.5;
      const j = jit ? ((seed - Math.floor(seed)) - 0.5) : 0;
      const x = x0 + j * 0.5 * jit;
      const z = front + dz * r + j * 0.4 * jit;
      const ry = faceBoard + (jit ? j * 0.7 : 0);
      furn("desk01", x, z, ry, 0.34, rm.theme, "desk");
      put("chair01", x, z + (rm.side === "north" ? 0.55 : -0.55), ry + Math.PI, rm.theme, jit && j > 0.2 ? "chair-down" : "chair");
    }
  }
}

function buildClassroom(rm: RoomDef, messy: boolean) {
  // teacher platform + desk near the board
  put("platform01", rm.cx, rm.boardZ + (rm.side === "north" ? 0.7 : -0.7), 0, rm.theme, "platform");
  furn("desk02", rm.cx + 1.4, rm.boardZ + (rm.side === "north" ? 1.0 : -1.0), 0, 0.36, rm.theme, "teacherdesk");
  deskGrid(rm, 2, 3, messy ? 1 : 0);
  // a bookshelf against a side wall, near the board
  const sx = rm.cx - rm.w / 2 + 0.45;
  furn("shelf01", sx, rm.boardZ + (rm.side === "north" ? 1.6 : -1.6), Math.PI / 2, 0.4, rm.theme, "shelf");
  if (messy) { // an extra knocked-about desk + a bin mid-room
    furn("desk01", rm.cx + rm.w / 2 - 0.8, rm.cz + 0.4, 0.5, 0.34, rm.theme, "desk");
    furn("trashbox01", rm.cx + rm.w / 2 - 0.5, rm.boardZ + (rm.side === "north" ? 1.2 : -1.2), 0, 0.22, rm.theme, "trash");
  }
}

function buildArt(rm: RoomDef) {
  // big art tables: pairs of desks pushed together, with stools around
  const tz = [rm.boardZ + 2.2, rm.boardZ + 4.2];
  for (const z of tz) {
    for (const dx of [-0.36, 0.36]) furn("desk01", rm.cx + dx, z, Math.PI / 2, 0.3, rm.theme, "arttable");
    block(rm.cx, z, 0.55, rm.theme);
    put("chair01", rm.cx - 1.0, z, Math.PI / 2, rm.theme, "stool");
    put("chair01", rm.cx + 1.0, z, -Math.PI / 2, rm.theme, "stool");
  }
  // supply shelf + a paint counter against the side walls
  furn("shelf01", rm.cx - rm.w / 2 + 0.45, rm.boardZ + 1.4, Math.PI / 2, 0.4, rm.theme, "shelf");
  furn("counter01_2", rm.cx + rm.w / 2 - 0.5, rm.boardZ + 2.4, -Math.PI / 2, 0.4, rm.theme, "counter");
}

function buildLibrary(rm: RoomDef) {
  // three book-stacks running across the room with reading aisles
  const stackZ = [rm.cz - 1.8, rm.cz + 0.0, rm.cz + 1.8];
  for (const z of stackZ) {
    for (const dx of [-2.6, 0, 2.6]) {
      put("shelf01", rm.cx + dx, z, 0, rm.theme, "stack");
      block(rm.cx + dx, z, 0.5, rm.theme);
    }
  }
  // reading desks near the board wall (south)
  for (const dx of [-2.8, 2.8]) {
    furn("desk02", rm.cx + dx, rm.boardZ - 0.9, 0, 0.36, rm.theme, "readdesk");
    put("chair01", rm.cx + dx, rm.boardZ - 1.4, Math.PI, rm.theme, "chair");
  }
}

function buildLab(rm: RoomDef) {
  // perimeter counters along the back (board) wall and the far side wall
  for (let i = -1; i <= 1; i++) {
    put("counter01_2", rm.cx + i * 2.6, rm.boardZ - 0.5, 0, rm.theme, "counter");
    block(rm.cx + i * 2.6, rm.boardZ - 0.5, 0.5, rm.theme);
  }
  furn("locker01_open", rm.cx + rm.w / 2 - 0.5, rm.boardZ - 1.8, -Math.PI / 2, 0.4, rm.theme, "locker");
  furn("locker01_open", rm.cx - rm.w / 2 + 0.5, rm.boardZ - 1.8, Math.PI / 2, 0.4, rm.theme, "locker");
  // central island bench with stools
  const iz = rm.cz + 0.4;
  for (const dx of [-1.4, 0, 1.4]) { put("counter01_2", rm.cx + dx, iz, Math.PI / 2, rm.theme, "counter"); block(rm.cx + dx, iz, 0.45, rm.theme); }
  for (const dx of [-1.4, 0, 1.4]) { put("chair01", rm.cx + dx, iz + 1.1, Math.PI, rm.theme, "stool"); put("chair01", rm.cx + dx, iz - 1.1, 0, rm.theme, "stool"); }
}

function buildMusic(rm: RoomDef) {
  // a "grand piano" (counter block) + bench near the board
  furn("counter01_2", rm.cx - 2.2, rm.boardZ - 1.0, 0, 0.0, rm.theme, "piano");
  block(rm.cx - 2.2, rm.boardZ - 1.0, 0.55, rm.theme);
  put("chair01", rm.cx - 2.2, rm.boardZ - 1.7, Math.PI, rm.theme, "stool");
  // two arcs of choir chairs facing the board (south)
  for (const z of [rm.cz + 0.2, rm.cz + 1.4]) {
    for (const dx of [-1.95, -0.65, 0.65, 1.95]) put("chair01", rm.cx + dx, z, 0, rm.theme, "chair");
  }
  // instrument storage shelves on both side walls (good cover)
  furn("shelf01", rm.cx - rm.w / 2 + 0.45, rm.cz - 0.2, Math.PI / 2, 0.4, rm.theme, "shelf");
  furn("shelf01", rm.cx + rm.w / 2 - 0.45, rm.cz + 1.2, -Math.PI / 2, 0.4, rm.theme, "shelf");
  // stage speakers flanking the board (small hiding nooks)
  for (const sgn of [-1, 1]) furn("speaker01_2", rm.cx + sgn * (rm.w / 2 - 0.9), rm.boardZ - 0.7, 0, 0.28, rm.theme, "speaker");
}

function buildGym(rm: RoomDef) {
  // mostly OPEN for running — equipment clusters give corner cover only
  // long benches along both side walls
  for (const z of [rm.cz - 1.0, rm.cz + 1.4]) {
    furn("counter01_2", rm.cx - rm.w / 2 + 0.5, z, Math.PI / 2, 0.4, rm.theme, "bench");
    furn("counter01_2", rm.cx + rm.w / 2 - 0.5, z, -Math.PI / 2, 0.4, rm.theme, "bench");
  }
  // a stacked-mats / crate cluster in each far (board-side) corner
  for (const sgn of [-1, 1]) {
    const x = rm.cx + sgn * (rm.w / 2 - 1.1);
    furn("trashbox01", x, rm.boardZ - 1.0, 0, 0.0, rm.theme, "crate");
    block(x, rm.boardZ - 1.0, 0.62, rm.theme);
  }
  // an equipment shelf + a pile of stacked chairs against the board wall
  furn("shelf01", rm.cx, rm.boardZ - 0.6, 0, 0.45, rm.theme, "shelf");
  for (const dx of [-0.2, 0.2]) put("chair01", rm.cx - rm.w / 2 + 1.4 + dx, rm.boardZ - 2.2, 0, rm.theme, "chair");
  block(rm.cx - rm.w / 2 + 1.4, rm.boardZ - 2.2, 0.45, rm.theme);
}

for (const rm of ROOMS) {
  if (rm.theme === "classroom") buildClassroom(rm, false);
  else if (rm.theme === "messy") buildClassroom(rm, true);
  else if (rm.theme === "art") buildArt(rm);
  else if (rm.theme === "library") buildLibrary(rm);
  else if (rm.theme === "lab") buildLab(rm);
  else if (rm.theme === "music") buildMusic(rm);
  else if (rm.theme === "gym") buildGym(rm);
}

// corridor furniture: lockers along the hallway walls (kept clear of every doorway),
// plus a few bins. The central spine (|x|<CW) is left clear as the main thoroughfare.
for (const x of [-9.0, -3.3, 3.3, 9.0]) furn("locker01_open", x, zAn + 0.45, 0, 0.34, "classroom", "locker");   // corridor A, north wall
for (const x of [-8.6, 8.6]) furn("locker01_open", x, zAs - 0.45, Math.PI, 0.34, "classroom", "locker");         // corridor A, south wall
for (const x of [-8.6, -2.2, 2.2, 8.6]) furn("locker01_open", x, zBs - 0.45, Math.PI, 0.34, "classroom", "locker"); // corridor B, south wall
for (const x of [-7.2, 7.2]) furn("locker01_open", x, zBn + 0.45, 0, 0.34, "classroom", "locker");               // corridor B, north wall
furn("trashbox01", -9.3, zAn + 0.7, 0, 0.22, "classroom", "trash");
furn("trashbox01", 9.3, zBs - 0.7, 0, 0.22, "classroom", "trash");

// Decorative floor props — rendered procedurally on the client by `kind` (mesh=""), but
// CARRY COLLIDERS so players can't walk through them (same no-ghost guarantee as walls).
// All sit in corners / against walls, clear of every spawn (verified by colltest).
const deco = (kind: string, x: number, z: number, ry: number, r: number, theme: Theme) =>
  FURNITURE.push({ mesh: "", x, z, ry, s: 1, r, theme, kind });
// more cabinets lining the corridors
deco("cabinet", -3.5, zAs - 0.45, 0, 0.4, "art");
deco("cabinet", 3.5, zAs - 0.45, 0, 0.4, "library");
deco("cabinet", -3.5, zBn + 0.45, Math.PI, 0.4, "lab");
deco("cabinet", 3.5, zBn + 0.45, Math.PI, 0.4, "music");
// a "fun model" / cabinet / plant tucked in a corner of each room
deco("cabinet", -9.2, -7.3, Math.PI / 2, 0.4, "classroom"); // n0 wooden cabinet
deco("plant", 2.8, -7.3, 0, 0.28, "messy");                 // n1 potted plant
deco("statue", 8.8, -7.3, 0, 0.35, "art");                  // n2 art sculpture
deco("globe", -9.3, 0.0, Math.PI / 2, 0.35, "library");     // m0 globe on a stand
deco("molecule", 9.3, -2.8, -Math.PI / 2, 0.3, "lab");      // m1 atom model
deco("plant", -9.2, 7.6, Math.PI / 2, 0.28, "music");       // s0 potted plant
deco("trophy", 9.2, 7.6, -Math.PI / 2, 0.4, "gym");         // s1 trophy cabinet

// derived colliders (server + client movement)
export const COLLIDERS: { x: number; z: number; r: number }[] =
  FURNITURE.filter((p) => p.r > 0).map((p) => ({ x: p.x, z: p.z, r: p.r }));

// ---------------------------------------------------------------------------
// SPAWNS — seeker at the central spine junction; one hider per room.
// (Positions are validated collision-free by tools/_work/colltest.ts.)
// ---------------------------------------------------------------------------
export const SPAWNS = {
  seeker: { x: 0, z: 0, ry: 0 },
  hiders: [
    { x: nCx[0], z: -7.6, ry: 0 },          // n0 classroom (near door)
    { x: nCx[1], z: -7.6, ry: 0 },          // n1 messy
    { x: nCx[2], z: -7.6, ry: 0 },          // n2 art
    { x: mCx[0] - 1.3, z: -2.9, ry: Math.PI }, // m0 library (near north door)
    { x: mCx[1] + 1.3, z: -2.9, ry: Math.PI }, // m1 lab
    { x: sCx[0], z: 7.7, ry: Math.PI },     // s0 music
    { x: sCx[1], z: 7.7, ry: Math.PI },     // s1 gym
  ],
};

// ---------------------------------------------------------------------------
// resolveMovement — clamp to the building box, push out of wall segments
// (axis-aligned capsules) and furniture circles. Used by client + server.
// ---------------------------------------------------------------------------
function pushSeg(x: number, z: number, s: WallSeg, rad: number): [number, number] {
  const minx = Math.min(s.x1, s.x2), maxx = Math.max(s.x1, s.x2);
  const minz = Math.min(s.z1, s.z2), maxz = Math.max(s.z1, s.z2);
  const cx = Math.max(minx, Math.min(maxx, x));
  const cz = Math.max(minz, Math.min(maxz, z));
  let dx = x - cx, dz = z - cz;
  let d = Math.hypot(dx, dz);
  if (d >= rad) return [x, z];
  if (d < 1e-4) {
    // on the centreline — push along the wall's thin axis
    if (s.z1 === s.z2) { dx = 0; dz = z >= s.z1 ? 1 : -1; }
    else { dx = x >= s.x1 ? 1 : -1; dz = 0; }
    d = 1;
  }
  return [cx + (dx / d) * rad, cz + (dz / d) * rad];
}

export function resolveMovement(x: number, z: number): [number, number] {
  const bx = ROOM.maxX - 0.02, bz = ROOM.maxZ - 0.02;
  x = Math.max(-bx, Math.min(bx, x));
  z = Math.max(-bz, Math.min(bz, z));
  const wr = PLAYER_RADIUS + HT;
  for (let pass = 0; pass < 2; pass++) {
    for (const s of WALLS) [x, z] = pushSeg(x, z, s, wr);
    for (const c of COLLIDERS) {
      const dx = x - c.x, dz = z - c.z, d = Math.hypot(dx, dz), min = c.r + PLAYER_RADIUS;
      if (d < min) {
        const nx = d > 1e-4 ? dx / d : 1, nz = d > 1e-4 ? dz / d : 0;
        x = c.x + nx * min; z = c.z + nz * min;
      }
    }
  }
  return [Math.max(-bx, Math.min(bx, x)), Math.max(-bz, Math.min(bz, z))];
}
