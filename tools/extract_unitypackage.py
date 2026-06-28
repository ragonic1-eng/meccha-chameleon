#!/usr/bin/env python3
"""Extract a .unitypackage (gzipped tar of <guid>/{asset,asset.meta,pathname})
into a normal Assets/ tree using each entry's original pathname.

Usage: python tools/extract_unitypackage.py <package.unitypackage> <out_dir>
"""
import sys, os, tarfile

def main():
    if len(sys.argv) < 3:
        print("usage: extract_unitypackage.py <pkg> <out_dir>")
        sys.exit(1)
    pkg, out = sys.argv[1], sys.argv[2]

    # First pass: map guid -> (pathname, has_asset)
    pathnames = {}
    assets = set()
    with tarfile.open(pkg, "r:gz") as t:
        for m in t:
            if not m.isfile():
                continue
            parts = m.name.split("/")
            if len(parts) < 2:
                continue
            guid, kind = parts[0], parts[-1]
            if kind == "pathname":
                pathnames[guid] = t.extractfile(m).read().decode("utf-8", "ignore").splitlines()[0].strip()
            elif kind == "asset":
                assets.add(guid)

    written = 0
    skipped = 0
    with tarfile.open(pkg, "r:gz") as t:
        for m in t:
            if not m.isfile() or not m.name.endswith("/asset"):
                continue
            guid = m.name.split("/")[0]
            rel = pathnames.get(guid)
            if not rel:
                skipped += 1
                continue
            dest = os.path.join(out, rel)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(dest, "wb") as f:
                f.write(t.extractfile(m).read())
            written += 1
    print(f"extracted {written} files to {out} ({skipped} skipped, {len(pathnames)} pathnames, {len(assets)} assets)")

if __name__ == "__main__":
    main()
