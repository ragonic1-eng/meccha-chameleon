import { Schema, type, MapSchema } from "@colyseus/schema";

export class PlayerState extends Schema {
  @type("string") id = "";
  @type("string") name = "Player";
  @type("string") role = "unassigned"; // Role
  @type("boolean") ready = false;
  @type("boolean") connected = true;
  @type("boolean") alive = true;
  @type("boolean") isHost = false;
  @type("boolean") isBot = false;
  @type("number") ping = 0;
  @type("string") pref = "auto"; // RolePref: which role this player wants next match

  // transform
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") z = 0;
  @type("number") ry = 0; // yaw radians
  @type("string") pose = "stand"; // Pose
  @type("string") surf = "floor"; // climbing surface: floor | wall | ceiling
}

export class GameState extends Schema {
  @type("string") code = ""; // 6-char join code
  @type("string") phase = "lobby"; // Phase
  @type("string") mode = "normal"; // GameMode
  @type("string") hostId = "";
  @type("number") timer = 0; // seconds remaining in current phase
  @type("number") hideSec = 90; // host-set hide (prep) duration, seconds (60..180)
  @type("string") winner = ""; // "hiders" | "seekers" | "" while in progress
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
}
