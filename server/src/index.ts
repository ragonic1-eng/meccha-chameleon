import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import express from "express";
import cors from "cors";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { GameRoom } from "./rooms/GameRoom";
import { resolveCode } from "./rooms/codes";
import { DEFAULT_PORT, ROOM_NAME } from "@shared/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || DEFAULT_PORT;

const app = express();
app.use(cors());
app.get("/health", (_req, res) => res.json({ ok: true }));

// Resolve a friendly 6-char room code to a Colyseus roomId for joinById().
app.get("/api/code/:code", (req, res) => {
  const roomId = resolveCode(req.params.code);
  if (!roomId) return res.status(404).json({ error: "not_found" });
  res.json({ roomId });
});

// In production, serve the built client (client/dist) from the same origin/port.
const clientDist = path.resolve(__dirname, "../../client/dist");
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get("*", (_req, res) => res.sendFile(path.join(clientDist, "index.html")));
  console.log(`[server] serving client from ${clientDist}`);
} else {
  console.log(`[server] client/dist not found — run "npm run dev" for the Vite dev server`);
}

const httpServer = createServer(app);
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

gameServer.define(ROOM_NAME, GameRoom);

httpServer.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}  (Colyseus + Express)`);
});
