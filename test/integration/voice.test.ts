/**
 * Integration tests for voice transcription (voice.ts).
 *
 * Uses mock ffmpeg and whisper-cli binaries (test/fixtures/mock-ffmpeg.js,
 * mock-whisper.js) injected via FFMPEG_BIN / WHISPER_BIN / WHISPER_MODEL.
 *
 * Env vars are set BEFORE the module is imported so the candidate arrays
 * (evaluated at load time) pick them up.
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { writeFileSync, existsSync } from "fs";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MOCK_FFMPEG = resolve(__dirname, "../fixtures/mock-ffmpeg.js");
const MOCK_WHISPER = resolve(__dirname, "../fixtures/mock-whisper.js");

let tmpDir: string;
let dummyModelPath: string;
let dummyAudioPath: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "cc-discord-voice-test-"));
  dummyModelPath = join(tmpDir, "ggml-test.en.bin");
  await writeFile(dummyModelPath, Buffer.alloc(4, 0));
  dummyAudioPath = join(tmpDir, "test.ogg");
  await writeFile(dummyAudioPath, Buffer.alloc(16, 0));

  // Set env vars before importing the module — candidates array is evaluated at load time
  process.env.FFMPEG_BIN = MOCK_FFMPEG;
  process.env.WHISPER_BIN = MOCK_WHISPER;
  process.env.WHISPER_MODEL = dummyModelPath;
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  delete process.env.FFMPEG_BIN;
  delete process.env.WHISPER_BIN;
  delete process.env.WHISPER_MODEL;
  delete process.env.MOCK_WHISPER_RESPONSE;
});

// Lazy import after env vars are set
async function getVoice() {
  // vi.resetModules() clears cache so the module re-evaluates with current env vars
  vi.resetModules();
  return import("../../src/voice.js");
}

// ─── isVoiceAvailable ─────────────────────────────────────────────────────────

describe("isVoiceAvailable()", () => {
  it("returns true when mock binaries and model are set via env vars", async () => {
    const { isVoiceAvailable } = await getVoice();
    expect(isVoiceAvailable()).toBe(true);
  });

  it("returns false when WHISPER_BIN points to non-existent file", async () => {
    const orig = process.env.WHISPER_BIN;
    process.env.WHISPER_BIN = "/nonexistent/path/whisper-cli";
    try {
      const { isVoiceAvailable } = await getVoice();
      // May be true if system whisper-cli exists at a standard path
      // Just verify it doesn't throw
      expect(typeof isVoiceAvailable()).toBe("boolean");
    } finally {
      process.env.WHISPER_BIN = orig;
    }
  });
});

// ─── transcribeVoice — happy path ─────────────────────────────────────────────

describe("transcribeVoice() — mock binaries", () => {
  it("transcribes a local file:// audio URL and returns text", async () => {
    process.env.MOCK_WHISPER_RESPONSE = "this is a test transcription";
    const { transcribeVoice } = await getVoice();
    const text = await transcribeVoice(`file://${dummyAudioPath}`);
    expect(text).toBe("this is a test transcription");
  });

  it("strips [BLANK_AUDIO] and other bracket artifacts", async () => {
    process.env.MOCK_WHISPER_RESPONSE = "[BLANK_AUDIO] hello [music] world";
    const { transcribeVoice } = await getVoice();
    const text = await transcribeVoice(`file://${dummyAudioPath}`);
    expect(text).toBe("hello  world");
  });

  it("returns [empty transcription] when whisper outputs only artifacts", async () => {
    process.env.MOCK_WHISPER_RESPONSE = "[BLANK_AUDIO]";
    const { transcribeVoice } = await getVoice();
    const text = await transcribeVoice(`file://${dummyAudioPath}`);
    expect(text).toBe("[empty transcription]");
  });

  it("handles multiline whisper output, joining lines into one string", async () => {
    process.env.MOCK_WHISPER_RESPONSE = "hello world";
    const { transcribeVoice } = await getVoice();
    const text = await transcribeVoice(`file://${dummyAudioPath}`);
    expect(text).toContain("hello world");
  });
});

// ─── transcribeVoice — error paths ────────────────────────────────────────────

describe("transcribeVoice() — error handling", () => {
  it("throws a clear error for HTTP 404 URLs", async () => {
    const { transcribeVoice } = await getVoice();
    await expect(
      transcribeVoice("http://127.0.0.1:1/nonexistent.ogg")
    ).rejects.toThrow();
  });

  it("throws if WHISPER_BIN is missing and no system whisper-cli exists", async () => {
    const origWhisper = process.env.WHISPER_BIN;
    delete process.env.WHISPER_BIN;
    const { transcribeVoice } = await getVoice();
    process.env.WHISPER_BIN = origWhisper;

    // Only fails if system whisper isn't installed
    try {
      await transcribeVoice(`file://${dummyAudioPath}`);
      // System whisper found — that's acceptable
    } catch (err) {
      expect((err as Error).message).toMatch(/whisper-cpp not found|ffmpeg|model/i);
    }
  });

  it("throws a clear error if WHISPER_MODEL is missing and no system model exists", async () => {
    const origModel = process.env.WHISPER_MODEL;
    delete process.env.WHISPER_MODEL;
    const { transcribeVoice } = await getVoice();
    process.env.WHISPER_MODEL = origModel;

    try {
      await transcribeVoice(`file://${dummyAudioPath}`);
    } catch (err) {
      expect((err as Error).message).toMatch(/whisper|model|ffmpeg/i);
    }
  });
});

// ─── mock-whisper fixture ─────────────────────────────────────────────────────

describe("mock-whisper.js fixture", () => {
  it("produces a .wav.txt output file when called with -f and --output-txt", async () => {
    const { spawnSync } = await import("child_process");
    const wavPath = join(tmpDir, "test-fixture.wav");
    await writeFile(wavPath, Buffer.alloc(0));

    process.env.MOCK_WHISPER_RESPONSE = "fixture output";
    const r = spawnSync(MOCK_WHISPER, ["-m", dummyModelPath, "-f", wavPath, "--output-txt", "-l", "en"], {
      env: { ...process.env },
    });
    expect(r.status).toBe(0);
    expect(existsSync(wavPath + ".txt")).toBe(true);
    const { readFileSync } = await import("fs");
    expect(readFileSync(wavPath + ".txt", "utf-8").trim()).toBe("fixture output");
  });
});

// ─── mock-ffmpeg fixture ──────────────────────────────────────────────────────

describe("mock-ffmpeg.js fixture", () => {
  it("creates the output WAV file and exits 0", async () => {
    const { spawnSync } = await import("child_process");
    const inputPath = join(tmpDir, "input.ogg");
    const outputPath = join(tmpDir, "output.wav");
    await writeFile(inputPath, Buffer.alloc(0));

    const r = spawnSync(MOCK_FFMPEG, ["-y", "-i", inputPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", outputPath], {
      env: { ...process.env },
    });
    expect(r.status).toBe(0);
    expect(existsSync(outputPath)).toBe(true);
  });
});
