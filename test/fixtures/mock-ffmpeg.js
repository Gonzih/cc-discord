#!/usr/bin/env node
/**
 * Mock ffmpeg for voice integration tests.
 *
 * Accepts all ffmpeg-style arguments.
 * Finds the output file from -i <input> ... <output> and creates it
 * as an empty WAV-like file so whisper can find it.
 * Exits 0 (success).
 */
import { writeFileSync } from "fs";

const args = process.argv.slice(2);

// Find output path: last non-flag argument
// ffmpeg: -y -i input.ogg -ar 16000 -ac 1 -c:a pcm_s16le output.wav
let outputPath = null;
const skipNext = new Set(["-i", "-ar", "-ac", "-c:a", "-f", "-ss", "-t"]);
let skip = false;
for (let i = 0; i < args.length; i++) {
  if (skip) { skip = false; continue; }
  if (skipNext.has(args[i])) { skip = true; continue; }
  if (args[i] === "-y") continue;
  if (!args[i].startsWith("-")) {
    outputPath = args[i];
  }
}

if (outputPath) {
  writeFileSync(outputPath, Buffer.alloc(44, 0));
}

process.exit(0);
