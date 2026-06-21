#!/usr/bin/env node
/**
 * Mock whisper-cli for voice integration tests.
 *
 * Accepts all whisper-cli-style arguments.
 * When --output-txt is passed with -f <wavFile>, writes a .wav.txt file.
 * The written text comes from MOCK_WHISPER_RESPONSE (default: "hello world").
 * Exits 0 (success).
 */
import { writeFileSync } from "fs";

const args = process.argv.slice(2);
const response = process.env.MOCK_WHISPER_RESPONSE ?? "hello world";

let wavFile = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "-f" && i + 1 < args.length) {
    wavFile = args[i + 1];
    break;
  }
}

const hasOutputTxt = args.includes("--output-txt");

if (wavFile && hasOutputTxt) {
  writeFileSync(wavFile + ".txt", response + "\n");
}

process.exit(0);
