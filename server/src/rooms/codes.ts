// Maps human-friendly 6-char room codes to Colyseus roomIds so players can join by code.
// Ambiguous characters (0/O, 1/I) are excluded for easy typing on phones.

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const codeToRoom = new Map<string, string>();

export function generateCode(): string {
  let code = "";
  do {
    code = "";
    for (let i = 0; i < 6; i++) {
      code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    }
  } while (codeToRoom.has(code));
  return code;
}

export function registerCode(code: string, roomId: string) {
  codeToRoom.set(code, roomId);
}

export function releaseCode(code: string) {
  codeToRoom.delete(code);
}

export function resolveCode(code: string): string | undefined {
  return codeToRoom.get(code.toUpperCase().trim());
}
