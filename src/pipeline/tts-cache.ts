import { createHash } from "crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";

const CACHE_DIR = path.resolve(process.cwd(), "storage", "tts-cache");

// Ensure cache dir exists on import
if (!existsSync(CACHE_DIR)) {
  mkdirSync(CACHE_DIR, { recursive: true });
}

function hashText(text: string): string {
  return createHash("sha256").update(text.trim().toLowerCase()).digest("hex");
}

function cachePath(hash: string): string {
  return path.join(CACHE_DIR, `${hash}.mulaw`);
}

/**
 * Check if we have cached audio for the given text.
 * Returns base64-encoded mulaw chunks (array) or null if not cached.
 */
export function getCachedAudio(text: string): string[] | null {
  const hash = hashText(text);
  const filePath = cachePath(hash);

  if (!existsSync(filePath)) return null;

  try {
    const raw = readFileSync(filePath);
    // File stores JSON array of base64 chunks
    return JSON.parse(raw.toString());
  } catch {
    return null;
  }
}

/**
 * Store TTS audio output for the given text.
 * Accepts an array of base64-encoded mulaw chunks.
 */
export function setCachedAudio(text: string, chunks: string[]): void {
  const hash = hashText(text);
  const filePath = cachePath(hash);

  try {
    writeFileSync(filePath, JSON.stringify(chunks));
  } catch {
    // Non-critical — just skip caching
  }
}
