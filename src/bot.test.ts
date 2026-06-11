import { describe, it, expect } from "vitest";
import { isAudioAttachment, buildAttachmentPrompt } from "./bot.js";

describe("isAudioAttachment", () => {
  it("detects .ogg by name", () => {
    expect(isAudioAttachment("voice.ogg", "")).toBe(true);
  });

  it("detects .mp3 by name", () => {
    expect(isAudioAttachment("track.mp3", "")).toBe(true);
  });

  it("detects .m4a by name", () => {
    expect(isAudioAttachment("memo.m4a", "")).toBe(true);
  });

  it("detects .wav by name", () => {
    expect(isAudioAttachment("sound.wav", "")).toBe(true);
  });

  it("detects .webm by name", () => {
    expect(isAudioAttachment("recording.webm", "")).toBe(true);
  });

  it("detects audio/ content-type prefix", () => {
    expect(isAudioAttachment("file", "audio/ogg")).toBe(true);
    expect(isAudioAttachment("file", "audio/mpeg")).toBe(true);
    expect(isAudioAttachment("file", "audio/webm")).toBe(true);
  });

  it("detects ogg via content-type substring", () => {
    expect(isAudioAttachment("file", "application/ogg")).toBe(true);
  });

  it("returns false for image attachments", () => {
    expect(isAudioAttachment("photo.jpg", "image/jpeg")).toBe(false);
  });

  it("returns false for PDF attachments", () => {
    expect(isAudioAttachment("report.pdf", "application/pdf")).toBe(false);
  });

  it("is case-insensitive for names", () => {
    expect(isAudioAttachment("VOICE.OGG", "")).toBe(true);
    expect(isAudioAttachment("Track.MP3", "")).toBe(true);
  });
});

describe("buildAttachmentPrompt", () => {
  it("builds ATTACHMENTS-only prompt when no caption", () => {
    const result = buildAttachmentPrompt("", "report.pdf", "/uploads/report.pdf");
    expect(result).toBe("ATTACHMENTS: [report.pdf](/uploads/report.pdf)");
  });

  it("combines caption and ATTACHMENTS when caption is present", () => {
    const result = buildAttachmentPrompt("please review this", "notes.txt", "/uploads/notes.txt");
    expect(result).toBe("please review this\n\nATTACHMENTS: [notes.txt](/uploads/notes.txt)");
  });

  it("uses empty string caption the same as no caption", () => {
    const result = buildAttachmentPrompt("", "data.csv", "/uploads/data.csv");
    expect(result).toBe("ATTACHMENTS: [data.csv](/uploads/data.csv)");
  });

  it("preserves spaces in file names", () => {
    const result = buildAttachmentPrompt("", "my report.pdf", "/uploads/my report.pdf");
    expect(result).toBe("ATTACHMENTS: [my report.pdf](/uploads/my report.pdf)");
  });
});
