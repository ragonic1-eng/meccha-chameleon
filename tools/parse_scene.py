#!/usr/bin/env python3
"""Parse a Unity scene + prefabs into a flat prop layout (raw Unity-space transforms).
The client applies the Unity->engine coordinate convention (so it can be calibrated quickly).

  python tools/parse_scene.py <package.unitypackage> tools/_extracted/Assets/<root> <out.json>
"""
import sys, os, re, json, tarfile, math

PKG, SRC, OUT = sys.argv[1], sys.argv[2], sys.argv[3]

# --- guid -> asset path, straight from the unitypackage folder names ---
guid_path = {}
with tarfile.open(PKG, "r:gz") as t:
    for m in t:
        if m.name.endswith("/pathname"):
            guid = m.name.split("/")[0]
            guid_path[guid] = t.extractfile(m).read().decode("utf-8", "ignore").splitlines()[0].strip()
path_guid = {v: k for k, v in guid_path.items()}

def mesh_name(guid):
    p = guid_path.get(guid, "")
    return os.path.splitext(os.path.basename(p))[0] if p.lower().endswith(".fbx") else None

# --- prefab guid -> mesh name ---
# Most prefabs are FBX-model variants (no direct MeshFilter), so map by longest name-prefix
# to an available mesh; fall back to a direct MeshFilter guid when present.
mesh_names = sorted({os.path.splitext(os.path.basename(p))[0] for p in guid_path.values() if p.lower().endswith(".fbx")}, key=len, reverse=True)

def best_mesh(basename):
    for mn in mesh_names:  # longest first
        if basename == mn or basename.startswith(mn + "_") or basename.startswith(mn):
            return mn
    return None

prefab_basename_guid = {os.path.basename(p): g for g, p in guid_path.items() if p.lower().endswith(".prefab")}
prefab_mesh = {}
pdir = os.path.join(SRC, "Prefabs")
for fn in os.listdir(pdir):
    if not fn.endswith(".prefab"):
        continue
    stem = fn[:-7]  # strip .prefab
    txt = open(os.path.join(pdir, fn), encoding="utf-8", errors="ignore").read()
    mm = re.search(r"m_Mesh: \{fileID: \d+, guid: ([0-9a-f]+)", txt)
    mn = (mesh_name(mm.group(1)) if mm else None) or best_mesh(stem)
    pg = prefab_basename_guid.get(fn)
    if pg and mn:
        prefab_mesh[pg] = mn

scene = open(os.path.join(SRC, "Scenes/School_Classroom.unity"), encoding="utf-8", errors="ignore").read()
blocks = re.split(r"^--- ", scene, flags=re.M)

def vec3(b, key, d=0.0):
    m = re.search(key + r": \{x: ([-\d.eE]+), y: ([-\d.eE]+), z: ([-\d.eE]+)", b)
    return [float(m.group(1)), float(m.group(2)), float(m.group(3))] if m else [d, d, d]

def quat(b, key):
    m = re.search(key + r": \{x: ([-\d.eE]+), y: ([-\d.eE]+), z: ([-\d.eE]+), w: ([-\d.eE]+)", b)
    return [float(m.group(i)) for i in range(1, 5)] if m else [0, 0, 0, 1]

def fileid(b, key):
    m = re.search(key + r": \{fileID: (-?\d+)", b)
    return m.group(1) if m else "0"

# --- scene Transforms (for parent-chain resolution) ---
transforms = {}
for b in blocks:
    if b.startswith("!u!4 &"):
        fid = b.split("&", 1)[1].split("\n", 1)[0].strip()
        transforms[fid] = {"pos": vec3(b, "m_LocalPosition"), "rot": quat(b, "m_LocalRotation"), "father": fileid(b, "m_Father")}

def qmul(a, b):
    ax, ay, az, aw = a; bx, by, bz, bw = b
    return [aw*bx+ax*bw+ay*bz-az*by, aw*by-ax*bz+ay*bw+az*bx, aw*bz+ax*by-ay*bx+az*bw, aw*bw-ax*bx-ay*by-az*bz]

def qrot(q, v):
    x, y, z, w = q; vx, vy, vz = v
    tx, ty, tz = 2*(y*vz-z*vy), 2*(z*vx-x*vz), 2*(x*vy-y*vx)
    return [vx+w*tx+(y*tz-z*ty), vy+w*ty+(z*tx-x*tz), vz+w*tz+(x*ty-y*tx)]

def yaw(q):
    # heading around Y (props rotate almost exclusively around Y)
    x, y, z, w = q
    return math.atan2(2*(w*y+x*z), 1-2*(y*y+x*x))

def world(local_pos, local_rot, parent):
    pos, rot, fid = local_pos, local_rot, parent
    while fid and fid != "0" and fid in transforms:
        p = transforms[fid]
        pos = qrot(p["rot"], pos)
        pos = [pos[0]+p["pos"][0], pos[1]+p["pos"][1], pos[2]+p["pos"][2]]
        rot = qmul(p["rot"], rot)
        fid = p["father"]
    return pos, rot

# --- prefab instances ---
props = []
used = set()
for b in blocks:
    if not b.startswith("!u!1001 &"):
        continue
    sm = re.search(r"m_(?:Source|Parent)Prefab: \{fileID: \d+, guid: ([0-9a-f]+)", b)
    if not sm:
        continue
    pg = sm.group(1)
    # most instances reference the FBX model guid directly; authored prefabs via prefab_mesh
    mn = mesh_name(pg) or prefab_mesh.get(pg)
    if not mn:
        continue
    mods = {}
    for mm in re.finditer(r"propertyPath: (\S+)\s+value: ([-\d.eE]+)\b", b):
        mods[mm.group(1)] = float(mm.group(2))
    lp = [mods.get("m_LocalPosition.x", 0), mods.get("m_LocalPosition.y", 0), mods.get("m_LocalPosition.z", 0)]
    lr = [mods.get("m_LocalRotation.x", 0), mods.get("m_LocalRotation.y", 0), mods.get("m_LocalRotation.z", 0), mods.get("m_LocalRotation.w", 1)]
    ls = [mods.get("m_LocalScale.x", 1), mods.get("m_LocalScale.y", 1), mods.get("m_LocalScale.z", 1)]
    parent = fileid(b, "m_TransformParent")
    wp, wr = world(lp, lr, parent)
    props.append({"mesh": mn, "p": [round(v, 4) for v in wp], "ry": round(yaw(wr), 5), "s": [round(v, 4) for v in ls]})
    used.add(mn)

# --- engine-space data (x = Unity z, z = Unity x; room centred at origin) ---
COLLIDE = {"desk": 0.32, "shelf": 0.4, "locker": 0.5, "counter": 0.5, "trashbox": 0.26}
def collide_r(mesh):
    for k, r in COLLIDE.items():
        if mesh.startswith(k):
            return r
    return None

clean, colliders, used2 = [], [], set()
for p in props:
    ex, ez = p["p"][2], p["p"][0]  # engine x, z
    mesh = p["mesh"]
    # drop mis-parented floating boards (legitimate ones hug a wall)
    if (mesh.startswith("blackboard") or mesh.startswith("board")) and abs(ex) < 3.5 and abs(ez) < 4.0:
        continue
    clean.append(p)
    used2.add(mesh)
    r = collide_r(mesh)
    if r:
        colliders.append({"x": round(ex, 3), "z": round(ez, 3), "r": r})

PR = 0.26
def push(x, z):
    for _ in range(3):
        for c in colliders:
            dx, dz = x - c["x"], z - c["z"]
            d = math.hypot(dx, dz)
            m = c["r"] + PR
            if d < m:
                nx, nz = (dx / d, dz / d) if d > 1e-3 else (1.0, 0.0)
                x, z = c["x"] + nx * m, c["z"] + nz * m
    return [round(x, 2), round(z, 2)]

hider_cfg = [((-3.4, -3.4), 0.0), ((3.4, -3.4), 0.0), ((-3.4, 0.0), math.pi / 2), ((3.4, 0.0), -math.pi / 2), ((-3.4, 3.4), 0.0), ((3.4, 3.4), 0.0)]
spawns = {
    "seeker": {"x": push(0, 4.2)[0], "z": push(0, 4.2)[1], "ry": round(math.pi, 5)},
    "hiders": [{"x": push(*s)[0], "z": push(*s)[1], "ry": round(r, 5)} for s, r in hider_cfg],
}
data = {"bounds": {"halfX": 4, "halfZ": 5}, "playerRadius": PR, "colliders": colliders, "spawns": spawns}
shared_path = os.path.join(os.path.dirname(__file__), "..", "shared", "src", "classroom-data.json")
json.dump(data, open(shared_path, "w"), indent=1)

out = {"props": clean, "meshes": sorted(used2)}
json.dump(out, open(OUT, "w"), indent=1)
print(f"parsed {len(clean)} props ({len(used2)} meshes), {len(colliders)} colliders -> {OUT} + {shared_path}")
