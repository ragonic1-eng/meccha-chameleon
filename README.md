# Meccha Chameleon — Mobile Web Hide & Seek

A mobile-friendly web-app recreation of **Meccha Chameleon**: 3D hide-and-seek where *hiders*
free-brush-paint their chameleon bodies to camouflage into the environment and *seekers* hunt
them in first person. Up to 6 players, host + join lobby, live ping, public server.

## Structure (npm workspaces monorepo)

| Folder    | What                                                                 |
|-----------|----------------------------------------------------------------------|
| `client/` | Vite + TypeScript + Three.js game client (mobile-first, PWA)         |
| `server/` | Node + Colyseus + Express authoritative game server (one deploy URL) |
| `shared/` | TypeScript types & constants shared by client and server (`@shared/*`)|
| `tools/`  | Unity `.unitypackage` → web-ready GLB asset pipeline                  |

## Develop

```bash
npm install
npm run dev          # runs server (:2567) + client (:5173) together
```

Open `http://localhost:5173` on desktop, or `http://<your-LAN-ip>:5173` on a phone on the
same WiFi. The ping indicator (top-left) shows live round-trip latency to the server.

## Production / deploy

One Node process serves the built client **and** the Colyseus game server, so the whole
game lives at a single URL (WebSockets included).

```bash
npm run build        # builds the client into client/dist
npm start            # server serves client/dist + Colyseus on $PORT (default 2567)
```

### Deploy to Railway (easiest)
1. Push this repo to GitHub.
2. railway.com → **New Project → Deploy from GitHub repo** → pick it.
3. Set **Build**: `npm install --omit=optional && npm run build`, **Start**: `npm start`.
4. Railway injects `PORT`; the server already reads it. Open the generated URL on any phone.

### Deploy to Render
Push to GitHub, then render.com → **New → Blueprint** and select this repo — it reads
[`render.yaml`](render.yaml). (Free tier sleeps when idle; first load wakes it.)

### Any container host (Fly.io, Docker, etc.)
A [`Dockerfile`](Dockerfile) is included: `docker build -t mcc . && docker run -p 8080:8080 mcc`.

### Test on real phones without deploying
Run `npm run dev`, then expose port **5173** with a tunnel (e.g. `cloudflared tunnel --url
http://localhost:5173` or `ngrok http 5173`) and open the public URL on your phones. The
client auto-detects same-origin vs dev and connects the game server accordingly.

## Rebuilding the classroom map (or adding new maps)

The converted map assets under `client/public/maps/` are committed, so deploys don't need the
pipeline. To regenerate them from the Unity `.unitypackage`:

```bash
npm i -D fbx2gltf sharp                       # local-only tools (optional deps)
python tools/extract_unitypackage.py "<pkg>" tools/_extracted
npm run map:build                             # FBX→GLB + texture resolve/compress + manifest
```

## Game rules (faithful to Meccha Chameleon)

4 phases — Team Assignment → Prep (hiders move/pose/paint; seekers frozen) → Hunt (seekers
released, tag to eliminate) → Results. Hiders win if **≥1** survives the timer; seekers win by
tagging everyone. Core loop: **Position → Pose → Paint** with an eyedropper ("Spoid") to sample
real surface colors.
