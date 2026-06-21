/**
 * Voice message transcription via whisper.cpp.
 * Flow: Discord voice memo (OGG/M4A) → ffmpeg convert to 16kHz WAV → whisper-cpp → text
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync, createWriteStream } from "fs";
import { unlink, readFile, access } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import https from "https";
import http from "http";

const execFileAsync = promisify(execFile);

// Env var overrides allow test injection: WHISPER_BIN, FFMPEG_BIN, WHISPER_MODEL
const WHISPER_MODELS = [
  process.env.WHISPER_MODEL,
  "/opt/homebrew/share/whisper-cpp/ggml-small.en.bin",
  "/opt/homebrew/share/whisper-cpp/ggml-small.bin",
  "/opt/homebrew/share/whisper-cpp/ggml-base.en.bin",
  "/opt/homebrew/share/whisper-cpp/ggml-base.bin",
  `${process.env.HOME}/.local/share/whisper-cpp/ggml-small.en.bin`,
  `${process.env.HOME}/.local/share/whisper-cpp/ggml-base.en.bin`,
].filter(Boolean) as string[];

const WHISPER_BIN_CANDIDATES = [
  process.env.WHISPER_BIN,
  "/opt/homebrew/bin/whisper-cli",
  "/opt/homebrew/bin/whisper-cpp",
  "/usr/local/bin/whisper-cli",
  "/usr/local/bin/whisper-cpp",
  "/opt/homebrew/bin/whisper",
].filter(Boolean) as string[];

const FFMPEG_CANDIDATES = [
  process.env.FFMPEG_BIN,
  "/opt/homebrew/bin/ffmpeg",
  "/usr/local/bin/ffmpeg",
  "/usr/bin/ffmpeg",
].filter(Boolean) as string[];

function findBin(candidates: string[]): string | null {
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function findModel(): string | null {
  for (const p of WHISPER_MODELS) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Download a file from a URL to dest.
 * Supports file:// (copies local file), and https/http with redirect following.
 */
async function downloadFile(url: string, dest: string, redirectsLeft = 5): Promise<void> {
  if (url.startsWith("file://")) {
    const { copyFile } = await import("fs/promises");
    await copyFile(url.slice("file://".length), dest);
    return;
  }
  return new Promise((resolve, reject) => {
    if (redirectsLeft <= 0) {
      reject(new Error(`Too many redirects downloading ${url}`));
      return;
    }
    const getter = url.startsWith("https") ? https : http;
    getter.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        downloadFile(res.headers.location, dest, redirectsLeft - 1).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
        return;
      }
      const file = createWriteStream(dest);
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve()));
      file.on("error", reject);
    }).on("error", reject);
  });
}

/**
 * Transcribe a voice message from a Discord CDN URL.
 * Accepts OGG, M4A, MP3, or any audio format ffmpeg can decode.
 * Returns the transcribed text, or throws if whisper/ffmpeg not available.
 */
export async function transcribeVoice(fileUrl: string): Promise<string> {
  const whisperBin = findBin(WHISPER_BIN_CANDIDATES);
  if (!whisperBin) throw new Error("whisper-cpp not found — install with: brew install whisper-cpp");

  const ffmpegBin = findBin(FFMPEG_CANDIDATES);
  if (!ffmpegBin) throw new Error("ffmpeg not found — install with: brew install ffmpeg");

  const model = findModel();
  if (!model) throw new Error("No whisper model found — run: whisper-cpp-download-ggml-model small.en");

  const tmp = join(tmpdir(), `cc-discord-voice-${Date.now()}`);
  // Preserve original extension so ffmpeg auto-detects format
  const urlPath = new URL(fileUrl).pathname;
  const ext = urlPath.includes(".") ? "." + urlPath.split(".").pop()!.split("?")[0] : ".ogg";
  const audioPath = `${tmp}${ext}`;
  const wavPath = `${tmp}.wav`;

  try {
    // 1. Download audio from Discord CDN (follows redirects)
    await downloadFile(fileUrl, audioPath);

    // 2. Convert to 16kHz mono WAV (whisper requirement)
    try {
      await execFileAsync(ffmpegBin, [
        "-y", "-i", audioPath,
        "-ar", "16000",
        "-ac", "1",
        "-c:a", "pcm_s16le",
        wavPath,
      ]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`ffmpeg conversion failed: ${msg}`);
    }

    // 3. Run whisper-cpp
    // -l auto fails with .en models — use -l en for those
    const isEnModel = model.includes(".en.");
    const langArgs = isEnModel ? ["-l", "en"] : ["-l", "auto"];

    let whisperStderr = "";
    try {
      const result = await execFileAsync(whisperBin, [
        "-m", model,
        "-f", wavPath,
        "--no-timestamps",
        ...langArgs,
        "--output-txt",
      ]);
      whisperStderr = result.stderr ?? "";
    } catch (err: unknown) {
      const e = err as { stderr?: string; message?: string };
      whisperStderr = e.stderr ?? "";
      const msg = e.message ?? String(err);
      throw new Error(`whisper-cpp failed: ${msg}\nstderr: ${whisperStderr}`);
    }

    // 4. Find output file — whisper-cpp versions differ on suffix:
    //    some write {wavPath}.txt, others write {baseName}.txt (strip .wav)
    const txtPathFull = `${wavPath}.txt`;                      // /tmp/foo.wav.txt
    const txtPathStripped = wavPath.replace(/\.wav$/, ".txt"); // /tmp/foo.txt

    let raw = "";
    for (const candidate of [txtPathFull, txtPathStripped]) {
      try {
        await access(candidate);
        raw = await readFile(candidate, "utf-8");
        await unlink(candidate).catch(() => {});
        break;
      } catch {
        // try next
      }
    }

    if (!raw && !whisperStderr) {
      throw new Error("whisper-cpp ran but produced no output file (tried .wav.txt and .txt)");
    }

    // Use stdout text if file wasn't found but whisper printed to stderr (some versions do)
    if (!raw) {
      raw = whisperStderr;
    }

    const text = raw
      .replace(/\[BLANK_AUDIO\]/gi, "")
      .replace(/\[.*?\]/g, "")
      .trim();

    return text || "[empty transcription]";
  } finally {
    await unlink(audioPath).catch(() => {});
    await unlink(wavPath).catch(() => {});
  }
}

/**
 * Check if voice transcription is available on this system.
 */
export function isVoiceAvailable(): boolean {
  return (
    findBin(WHISPER_BIN_CANDIDATES) !== null &&
    findBin(FFMPEG_CANDIDATES) !== null &&
    findModel() !== null
  );
}
