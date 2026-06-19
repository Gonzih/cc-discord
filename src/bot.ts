/**
 * Discord bot that routes messages to/from a Claude Code subprocess.
 * One ClaudeProcess per channel (or channel:thread) — sessions are isolated per channel.
 */

import {
  Client,
  GatewayIntentBits,
  Guild,
  Message,
  MessageReaction,
  PartialMessageReaction,
  User,
  PartialUser,
  REST,
  Routes,
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  AttachmentBuilder,
  Events,
  TextChannel,
  DMChannel,
  NewsChannel,
  ThreadChannel,
  VoiceChannel,
  ChannelType,
} from "discord.js";
import { existsSync, createWriteStream, mkdirSync, statSync, readdirSync, rmSync } from "fs";
import { resolve, basename, join } from "path";
import { homedir } from "os";
import https from "https";
import http from "http";
import { Redis } from "ioredis";
import { createCcWire } from "@gonzih/cc-wire";
import { ClaudeProcess, extractText, ClaudeMessage, UsageEvent } from "./claude.js";
import { transcribeVoice, isVoiceAvailable } from "./voice.js";
import { formatForDiscord, splitLongMessage, stripAnsi } from "./formatter.js";
import { getCurrentToken, rotateToken, getTokenIndex, getTokenCount } from "./tokens.js";
import { writeChatLog, type ChatMessage } from "./notifier.js";
import { LoopManager, isGoalMessage, type EvalReport } from "./loop-manager.js";
import { CronManager } from "./cron.js";
import { CronEngine } from "./cron-engine.js";
import { parseChannelCreateIntent, routeToMetaAgent } from "./router.js";
import { createMetaAgentManager, type MetaAgentManager } from "./meta-agent-manager.js";

type SendableChannel = TextChannel | DMChannel | NewsChannel | ThreadChannel | VoiceChannel;

/** Convert a Discord snowflake string to a safe 53-bit integer for CronManager compatibility. */
function snowflakeToInt(id: string): number {
  // Discord snowflakes are up to 2^63, beyond Number.MAX_SAFE_INTEGER.
  // Mask to 53 bits for safe integer range while maintaining per-channel consistency.
  return Number(BigInt(id) & BigInt(0x001FFFFFFFFFFFFF));
}

// Claude Sonnet 4.6 pricing (per 1M tokens)
const PRICING = {
  inputPerM: 3.00,
  outputPerM: 15.00,
  cacheReadPerM: 0.30,
  cacheWritePerM: 3.75,
};

interface SessionCost {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalCostUsd: number;
  messageCount: number;
}

function computeCostUsd(usage: UsageEvent): number {
  return (
    usage.inputTokens * PRICING.inputPerM / 1_000_000 +
    usage.outputTokens * PRICING.outputPerM / 1_000_000 +
    usage.cacheReadTokens * PRICING.cacheReadPerM / 1_000_000 +
    usage.cacheWriteTokens * PRICING.cacheWritePerM / 1_000_000
  );
}

interface Session {
  claude: ClaudeProcess;
  pendingText: string;
  flushTimer: ReturnType<typeof setTimeout> | null;
  typingTimer: ReturnType<typeof setInterval> | null;
  /** Files written by Claude tools during this turn — cleared after each result */
  writtenFiles: Set<string>;
  /** The last prompt sent to this session */
  currentPrompt: string;
}

// Debounces streaming chunks. Resets on each chunk. Fires 800ms after last chunk.
const FLUSH_DELAY_MS = 800;
// Discord typing indicator: re-send every 9s (indicator expires after ~10s)
const TYPING_INTERVAL_MS = 9000;

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Returns true if the attachment name/contentType indicates an audio file. */
export function isAudioAttachment(name: string, contentType: string): boolean {
  const n = name.toLowerCase();
  const ct = contentType.toLowerCase();
  return (
    ct.startsWith("audio/") ||
    n.endsWith(".ogg") || n.endsWith(".mp3") || n.endsWith(".m4a") ||
    n.endsWith(".wav") || n.endsWith(".webm") ||
    ct.includes("ogg") || ct.includes("mpeg") || ct.includes("mp4a")
  );
}

/** Build the prompt text for a file/document attachment, optionally with caption. */
export function buildAttachmentPrompt(caption: string, fileName: string, filePath: string): string {
  const ref = `[${fileName}](${filePath})`;
  return caption ? `${caption}\n\nATTACHMENTS: ${ref}` : `ATTACHMENTS: ${ref}`;
}

/** Prepend [DayOfWeek HH:MM] username: so Claude knows when the message was received and from whom. */
export function stampPrompt(text: string, username?: string, now = new Date()): string {
  const day = DAYS[now.getDay()];
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  const header = username ? `[${day} ${hh}:${min}] ${username}: ` : `[${day} ${hh}:${min}] `;
  return header + text;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** Download a URL to a file on disk. */
function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    const getter = url.startsWith("https") ? https : http;
    getter.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
        return;
      }
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve()));
      file.on("error", reject);
    }).on("error", reject);
  });
}

/** Fetch a URL and return it as a base64 string. */
async function fetchAsBase64(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const getter = url.startsWith("https") ? https : http;
    getter.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("base64")));
      res.on("error", reject);
    }).on("error", reject);
  });
}

/**
 * Resolve the Discord category ID to use as `parent` when creating new text channels.
 * Priority: DISCORD_DEFAULT_CATEGORY_ID env var → first category named "Text Channels" → undefined.
 */
function resolveCategoryId(guild: Guild): string | undefined {
  if (process.env.DISCORD_DEFAULT_CATEGORY_ID) return process.env.DISCORD_DEFAULT_CATEGORY_ID;
  const category = guild.channels.cache.find(
    (ch) => ch.type === ChannelType.GuildCategory && /text channels/i.test(ch.name),
  );
  return category?.id;
}

export interface DiscordBotOptions {
  discordToken: string;
  claudeToken?: string;
  cwd?: string;
  allowedUserIds?: string[];
  redis?: Redis;
  namespace?: string;
  guildIds?: string[];
  /** Instance ID for singleton overlap detection */
  instanceId?: string;
  /** Called when a message is routed to a non-default namespace so the notifier
   *  can forward the response back to the originating Discord channel. */
  registerRoutedChannelId?: (namespace: string, channelId: string) => void;
}

/** MCP tool call result — returned from callCcAgentTool */
export type CallToolFn = (toolName: string, args?: Record<string, unknown>) => Promise<string | null>;

export class CcDiscordBot {
  private client: Client;
  private sessions = new Map<string, Session>();
  private costs = new Map<string, SessionCost>();
  private opts: DiscordBotOptions;
  private redis?: Redis;
  private wire?: ReturnType<typeof createCcWire>;
  private namespace: string;
  private lastActiveChannelId?: string;
  private cron: CronManager;
  private cronEngine?: CronEngine;
  private metaAgentManager: MetaAgentManager;
  /** ClaudeProcess running the MCP tool bridge (for callCcAgentTool) */
  private mcpSession?: ClaudeProcess;

  private loopManager?: LoopManager;

  constructor(opts: DiscordBotOptions) {
    this.opts = opts;
    this.redis = opts.redis;
    this.namespace = opts.namespace ?? "default";
    if (opts.redis) {
      this.wire = createCcWire(opts.redis);
      this.loopManager = new LoopManager(opts.redis);
      this.cronEngine = new CronEngine(opts.redis);
    }
    this.metaAgentManager = createMetaAgentManager();

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessageReactions,
      ],
    });

    this.cron = new CronManager(opts.cwd ?? process.cwd(), (chatIdNum, prompt, _jobId, done) => {
      // Reverse-lookup channelId from the stored integer
      const channelId = this.reverseSnowflakeLookup(chatIdNum);
      if (!channelId) {
        console.warn(`[cron] no channelId found for chatId=${chatIdNum}`);
        done();
        return;
      }
      this.runCronTask(channelId, prompt, done);
    });

    this.client.once(Events.ClientReady, (readyClient) => {
      console.log(`[discord] logged in as ${readyClient.user.tag}`);
      this.registerSlashCommands().catch((err: Error) => {
        console.error("[discord] slash command registration failed:", err.message);
      });
      // Pre-populate snowflakeMap so reverse-lookup works for all channels visible at login
      for (const [, guild] of readyClient.guilds.cache) {
        for (const [, channel] of guild.channels.cache) {
          this.storeSnowflake(channel.id);
        }
      }
    });

    this.client.on(Events.MessageCreate, (msg) => {
      void this.handleMessage(msg);
    });

    this.client.on(Events.InteractionCreate, (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      void this.handleSlashCommand(interaction);
    });

    this.client.on(Events.MessageReactionAdd, (reaction, user) => {
      void this.handleReactionAdd(reaction as MessageReaction | PartialMessageReaction, user as User | PartialUser);
    });

    this.client.on("error", (err: Error) => {
      console.error("[discord] client error:", err.message);
    });

    void this.client.login(opts.discordToken);
    console.log("[discord] bot starting...");
    console.log(`[voice] whisper available: ${isVoiceAvailable()}`);
  }

  /** Reverse-lookup: find the channelId string for a cron-stored integer */
  private snowflakeMap = new Map<number, string>();

  /** Channels created by the bot for a meta-agent namespace → skip local Claude session */
  private channelNamespaceMap = new Map<string, { namespace: string; repoUrl: string }>();

  private storeSnowflake(channelId: string): number {
    const n = snowflakeToInt(channelId);
    this.snowflakeMap.set(n, channelId);
    return n;
  }

  public reverseSnowflakeLookup(n: number): string | undefined {
    return this.snowflakeMap.get(n);
  }

  /** Persist a channelId → {namespace, repoUrl} mapping to Redis via wire.discord. */
  private persistChannelMapping(channelId: string, namespace: string, repoUrl: string): void {
    if (!this.wire) return;
    this.wire.discord.registerChannel(channelId, namespace, repoUrl).catch((err: Error) => {
      console.warn(`[bot] persistChannelMapping failed for ${channelId}:`, err.message);
    });
  }

  /**
   * Load persisted channel→namespace mappings from Redis and repopulate
   * channelNamespaceMap + routedChannelIds. Call once on startup after the notifier is ready.
   */
  public async loadChannelMappings(): Promise<void> {
    if (!this.wire) return;
    let channels: Array<{ channelId: string; namespace: string; repoUrl: string }>;
    try {
      channels = await this.wire.discord.listChannels();
    } catch (err) {
      console.warn("[bot] loadChannelMappings failed:", (err as Error).message);
      return;
    }
    for (const { channelId, namespace, repoUrl } of channels) {
      if (!this.channelNamespaceMap.has(channelId)) {
        this.channelNamespaceMap.set(channelId, { namespace, repoUrl });
        this.opts.registerRoutedChannelId?.(namespace, channelId);
        console.log(`[bot] restored channel mapping: ${channelId} → ${namespace}`);
      }
    }
  }

  /** Typing intervals for meta-agent routed channels — keyed by channelId. */
  private metaAgentTypingTimers = new Map<string, ReturnType<typeof setInterval>>();

  /** Start (or reset) the typing indicator for a meta-agent–routed channel. */
  private startMetaAgentTyping(channelId: string, channel: SendableChannel): void {
    this.stopMetaAgentTyping(channelId);
    (channel as TextChannel).sendTyping().catch(() => {});
    this.metaAgentTypingTimers.set(
      channelId,
      setInterval(() => { (channel as TextChannel).sendTyping().catch(() => {}); }, TYPING_INTERVAL_MS)
    );
  }

  /** Stop the typing indicator for a meta-agent–routed channel. Called by the notifier on flush. */
  public stopMetaAgentTyping(channelId: string): void {
    const timer = this.metaAgentTypingTimers.get(channelId);
    if (timer) {
      clearInterval(timer);
      this.metaAgentTypingTimers.delete(channelId);
    }
  }

  /** Session key: "channelId" or "channelId:threadId" for threads */
  private sessionKey(channelId: string, threadId?: string): string {
    return threadId ? `${channelId}:${threadId}` : channelId;
  }

  /** Get the channel/thread for sending messages */
  private async getChannel(channelId: string): Promise<SendableChannel | null> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel) return null;
      if (
        channel.type === ChannelType.GuildText ||
        channel.type === ChannelType.DM ||
        channel.type === ChannelType.GuildNews ||
        channel.type === ChannelType.PublicThread ||
        channel.type === ChannelType.PrivateThread ||
        channel.type === ChannelType.GuildVoice
      ) {
        return channel as SendableChannel;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Send text to a channel, splitting at 2000 chars, sending file attachments if detected. */
  private async sendToChannel(channel: SendableChannel, text: string): Promise<void> {
    // Check for file paths written by Claude tools (lines like: "File written: /path/to/file")
    const filePathMatch = text.match(/(?:^|\n)\s*(?:file written|wrote file|created file|saved to|output:)\s*[:\-]?\s*(\/[^\s\n]+)/im);
    if (filePathMatch) {
      const filePath = filePathMatch[1].trim();
      if (existsSync(filePath)) {
        try {
          const attachment = new AttachmentBuilder(filePath, { name: basename(filePath) });
          await (channel as TextChannel).send({ files: [attachment] });
          return;
        } catch (err) {
          console.warn(`[bot] failed to send file ${filePath}:`, (err as Error).message);
        }
      }
    }

    const formatted = formatForDiscord(text);
    const chunks = splitLongMessage(formatted);
    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      await (channel as TextChannel).send(chunk).catch((err: Error) => {
        console.error("[bot] send failed:", err.message);
      });
    }
  }

  /** Send to a channel by ID — used by notifier callbacks. */
  public async sendToChannelById(channelId: string, text: string): Promise<void> {
    const channel = await this.getChannel(channelId);
    if (!channel) {
      console.warn(`[bot] sendToChannelById: channel ${channelId} not found`);
      return;
    }
    await this.sendToChannel(channel, text);
  }

  /**
   * Send text to a channel by ID, scanning for absolute file paths and attaching them.
   * Used exclusively for Claude coordinator output (meta-agent flush).
   * Falls back to plain text send if no valid files are found.
   */
  public async sendWithFileDetection(channelId: string, text: string): Promise<void> {
    const channel = await this.getChannel(channelId);
    if (!channel) {
      console.warn(`[bot] sendWithFileDetection: channel ${channelId} not found`);
      return;
    }

    // Extract absolute paths from text — handle bare paths and backtick-wrapped paths
    const rawMatches = text.match(/`(\/[^`\s]+)`|\/[^\s`'"]+/g) ?? [];
    const candidates = rawMatches.map((m) => m.replace(/^`|`$/g, ""));

    const MAX_SIZE = 8 * 1024 * 1024;
    const validPaths: string[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
      // Strip trailing punctuation that may have been caught by the regex
      const p = candidate.replace(/[.,;:!?)]+$/, "");
      if (seen.has(p)) continue;
      seen.add(p);
      try {
        if (existsSync(p)) {
          const st = statSync(p);
          if (st.isFile() && st.size < MAX_SIZE) {
            validPaths.push(p);
          }
        }
      } catch {
        // ignore stat errors
      }
    }

    if (validPaths.length > 0) {
      const formatted = formatForDiscord(text);
      const chunks = splitLongMessage(formatted);
      // Send first chunk with file attachments, remaining chunks as plain text
      const files = validPaths.map((p) => ({ attachment: p, name: basename(p) }));
      try {
        await (channel as TextChannel).send({ content: chunks[0] || undefined, files });
      } catch (err) {
        console.warn(`[bot] sendWithFileDetection attach failed:`, (err as Error).message);
        // Fall back to plain text for the first chunk
        if (chunks[0]?.trim()) {
          await (channel as TextChannel).send(chunks[0]).catch((e: Error) => {
            console.error("[bot] sendWithFileDetection fallback failed:", e.message);
          });
        }
      }
      for (const chunk of chunks.slice(1)) {
        if (!chunk.trim()) continue;
        await (channel as TextChannel).send(chunk).catch((e: Error) => {
          console.error("[bot] send failed:", e.message);
        });
      }
    } else {
      await this.sendToChannel(channel, text);
    }
  }

  private isAllowed(userId: string): boolean {
    if (!this.opts.allowedUserIds?.length) return true;
    return this.opts.allowedUserIds.includes(userId);
  }

  private async handleMessage(msg: Message): Promise<void> {
    // Skip bots (including self)
    if (msg.author.bot) return;

    const userId = msg.author.id;
    if (!this.isAllowed(userId)) return;

    // Track last active channel
    this.lastActiveChannelId = msg.channelId;

    const channelId = msg.channelId;
    const threadId = msg.channel.isThread() ? msg.channelId : undefined;
    // For threads, the parent channel is the actual channel
    const effectiveChannelId = threadId ?? channelId;
    const sessionKey = this.sessionKey(effectiveChannelId, threadId);

    // Store snowflake mapping for cron reverse-lookup
    this.storeSnowflake(effectiveChannelId);

    // Check for voice/audio attachments
    const audioAttachment = msg.attachments.find((att) =>
      isAudioAttachment(att.name ?? "", att.contentType ?? "")
    );

    if (audioAttachment) {
      await this.handleVoice(msg, effectiveChannelId, audioAttachment.url, audioAttachment.name ?? "audio.ogg");
      return;
    }

    // Image attachments
    const imageAttachment = msg.attachments.find((att) => {
      const ct = att.contentType?.toLowerCase() ?? "";
      return ct.startsWith("image/");
    });

    if (imageAttachment) {
      await this.handleImage(msg, effectiveChannelId, imageAttachment.url, imageAttachment.contentType ?? "image/jpeg");
      return;
    }

    // Other file/document attachments
    const docAttachment = msg.attachments.first();
    if (docAttachment) {
      await this.handleDocument(msg, effectiveChannelId, docAttachment.url, docAttachment.name ?? "file");
      return;
    }

    let text = msg.content.trim();
    if (!text) return;

    // Strip @mention
    text = text.replace(/<@!?\d+>/g, "").trim();
    if (!text) return;

    // Prepend replied-to message content so Claude can resurrect context
    if (msg.reference?.messageId) {
      try {
        const referenced = await msg.channel.messages.fetch(msg.reference.messageId);
        const refContent = referenced.content.length > 300
          ? referenced.content.slice(0, 300) + "…"
          : referenced.content;
        const refAuthor = referenced.member?.displayName ?? referenced.author.username;
        text = `> [replying to ${refAuthor}]: ${refContent}\n${text}`;
      } catch {
        // Referenced message unavailable — proceed without context
      }
    }

    // Natural-language channel creation: "channel for https://github.com/org/repo"
    if (this.redis) {
      const intent = parseChannelCreateIntent(text);
      if (intent) {
        await this.createChannelForRepo(msg, intent.namespace, intent.repoUrl);
        return;
      }
    }

    // Handle messages sent inside a loop thread — route to the running meta-agent session
    if (msg.channel.isThread() && this.redis && this.loopManager) {
      const parentId = (msg.channel as ThreadChannel).parentId;
      if (parentId) {
        const loopState = this.loopManager.getState(parentId);
        if (loopState && loopState.threadId === effectiveChannelId) {
          const username = msg.member?.displayName ?? msg.author.username;
          this.startMetaAgentTyping(effectiveChannelId, msg.channel as SendableChannel);
          try {
            await routeToMetaAgent(loopState.namespace, stampPrompt(text, username, msg.createdAt), this.redis);
          } catch (err) {
            await (msg.channel as ThreadChannel).send(`Failed to route: ${(err as Error).message}`).catch(() => {});
          }
          return;
        }
      }
    }

    // Channel registered via createChannelForRepo or /channel — route directly to its meta-agent
    const mappedNs = this.channelNamespaceMap.get(effectiveChannelId);
    if (mappedNs && this.redis) {
      // If a loop is already running for this channel, point the user to the thread
      if (this.loopManager?.isActive(effectiveChannelId)) {
        const loopState = this.loopManager.getState(effectiveChannelId)!;
        await (msg.channel as TextChannel).send(
          `Loop in progress → <#${loopState.threadId}>\nSend messages in the thread to interact with the running loop.`
        ).catch(() => {});
        return;
      }

      this.writeChatMessage("user", "discord", text, effectiveChannelId, mappedNs.namespace);
      this.opts.registerRoutedChannelId?.(mappedNs.namespace, effectiveChannelId);
      this.persistChannelMapping(effectiveChannelId, mappedNs.namespace, mappedNs.repoUrl);
      this.startMetaAgentTyping(effectiveChannelId, msg.channel as SendableChannel);

      // Detect goal messages → create a thread for loop tracking
      if (this.loopManager && msg.guild && !msg.channel.isThread()) {
        if (isGoalMessage(text)) {
          await this.createLoopThread(msg, effectiveChannelId, mappedNs.namespace, text);
        }
      }

      const username = msg.member?.displayName ?? msg.author.username;
      try {
        await routeToMetaAgent(mappedNs.namespace, stampPrompt(text, username, msg.createdAt), this.redis);
      } catch (err) {
        await (msg.channel as TextChannel).send(`Failed to route to ${mappedNs.namespace}: ${(err as Error).message}`).catch(() => {});
      }
      return;
    }

    // Unknown guild channel — reject rather than silently start a local session with wrong context
    if (msg.guild) {
      await (msg.channel as TextChannel).send(
        "This channel is not configured. Use `channel for https://github.com/org/repo` to set it up."
      ).catch(() => {});
      return;
    }

    // Local Claude session (DMs only beyond this point)
    const session = this.getOrCreateSession(effectiveChannelId, msg.channel as SendableChannel);
    const username = msg.member?.displayName ?? msg.author.username;
    try {
      session.currentPrompt = text;
      session.claude.sendPrompt(stampPrompt(text, username, msg.createdAt));
      this.startTyping(effectiveChannelId, msg.channel as SendableChannel, session);
      this.writeChatMessage("user", "discord", text, effectiveChannelId);
    } catch (err) {
      await (msg.channel as TextChannel).send(`Error sending to Claude: ${(err as Error).message}`).catch(() => {});
      this.killSession(effectiveChannelId);
    }
  }

  private async handleVoice(msg: Message, channelId: string, audioUrl: string, _fileName: string): Promise<void> {
    const channel = msg.channel as SendableChannel;
    await (channel as TextChannel).sendTyping().catch(() => {});

    try {
      const transcript = await transcribeVoice(audioUrl);
      if (!transcript || transcript === "[empty transcription]") {
        await (channel as TextChannel).send("Could not transcribe voice message.").catch(() => {});
        return;
      }

      // Combine transcript with caption text if present
      const caption = msg.content.trim().replace(/<@!?\d+>/g, "").trim();
      const fullText = caption ? `${caption}\n\n${transcript}` : transcript;
      const voiceUsername = msg.member?.displayName ?? msg.author.username;

      // Meta-agent routing
      const mappedNs = this.channelNamespaceMap.get(channelId);
      if (mappedNs && this.redis) {
        const labeledText = `[voice note — transcription may contain typos]: ${fullText}`;
        const prompt = stampPrompt(labeledText, voiceUsername, msg.createdAt);
        this.writeChatMessage("user", "discord", fullText, channelId, mappedNs.namespace);
        this.opts.registerRoutedChannelId?.(mappedNs.namespace, channelId);
        this.persistChannelMapping(channelId, mappedNs.namespace, mappedNs.repoUrl);
        this.startMetaAgentTyping(channelId, channel);
        try {
          await routeToMetaAgent(mappedNs.namespace, prompt, this.redis);
        } catch (err) {
          await (channel as TextChannel).send(`Failed to route to ${mappedNs.namespace}: ${(err as Error).message}`).catch(() => {});
        }
        return;
      }

      const session = this.getOrCreateSession(channelId, channel);
      session.currentPrompt = fullText;
      session.claude.sendPrompt(stampPrompt(fullText, voiceUsername, msg.createdAt));
      this.startTyping(channelId, channel, session);
      this.writeChatMessage("user", "discord", fullText, channelId);
    } catch (err) {
      const errMsg = (err as Error).message;
      let userMsg: string;
      if (errMsg.includes("whisper-cpp not found")) {
        userMsg = "Voice transcription unavailable — whisper-cpp not installed";
      } else if (errMsg.includes("No whisper model found")) {
        userMsg = "Voice transcription unavailable — no whisper model found";
      } else {
        userMsg = `Voice transcription failed: ${errMsg}`;
      }
      await (channel as TextChannel).send(userMsg).catch(() => {});
    }
  }

  private async handleImage(msg: Message, channelId: string, imageUrl: string, contentType: string): Promise<void> {
    const channel = msg.channel as SendableChannel;
    await (channel as TextChannel).sendTyping().catch(() => {});

    const caption = msg.content.trim().replace(/<@!?\d+>/g, "").trim();
    const imgUsername = msg.member?.displayName ?? msg.author.username;

    try {
      // Meta-agent routing: save to disk and send as ATTACHMENTS path reference
      const mappedNs = this.channelNamespaceMap.get(channelId);
      if (mappedNs && this.redis) {
        const ext = contentType.split("/")[1]?.replace("jpeg", "jpg") ?? "jpg";
        const fileName = `image_${crypto.randomUUID()}.${ext}`;
        const uploadsDir = resolve(this.opts.cwd ?? process.cwd(), ".cc-discord", "uploads");
        mkdirSync(uploadsDir, { recursive: true });
        const dest = join(uploadsDir, fileName);
        await downloadFile(imageUrl, dest);
        const fullText = buildAttachmentPrompt(caption, fileName, dest);
        const prompt = stampPrompt(fullText, imgUsername, msg.createdAt);
        this.writeChatMessage("user", "discord", fullText, channelId, mappedNs.namespace);
        this.opts.registerRoutedChannelId?.(mappedNs.namespace, channelId);
        this.persistChannelMapping(channelId, mappedNs.namespace, mappedNs.repoUrl);
        this.startMetaAgentTyping(channelId, channel);
        try {
          await routeToMetaAgent(mappedNs.namespace, prompt, this.redis);
        } catch (err) {
          await (channel as TextChannel).send(`Failed to route to ${mappedNs.namespace}: ${(err as Error).message}`).catch(() => {});
        }
        return;
      }

      // Local Claude session: send as base64
      const base64Data = await fetchAsBase64(imageUrl);
      const session = this.getOrCreateSession(channelId, channel);
      session.claude.sendImage(base64Data, contentType, stampPrompt(caption, imgUsername, msg.createdAt));
      this.startTyping(channelId, channel, session);
      this.writeChatMessage("user", "discord", caption || "[image]", channelId);
    } catch (err) {
      await (channel as TextChannel).send(`Failed to process image: ${(err as Error).message}`).catch(() => {});
    }
  }

  private async handleDocument(msg: Message, channelId: string, fileUrl: string, fileName: string): Promise<void> {
    const channel = msg.channel as SendableChannel;
    await (channel as TextChannel).sendTyping().catch(() => {});

    const uploadsDir = resolve(this.opts.cwd ?? process.cwd(), ".cc-discord", "uploads");
    mkdirSync(uploadsDir, { recursive: true });
    const dest = join(uploadsDir, fileName);

    try {
      await downloadFile(fileUrl, dest);
    } catch (err) {
      await (channel as TextChannel).send(`Failed to download file: ${(err as Error).message}`).catch(() => {});
      return;
    }

    const caption = msg.content.trim().replace(/<@!?\d+>/g, "").trim();
    const fullText = buildAttachmentPrompt(caption, fileName, dest);
    const username = msg.member?.displayName ?? msg.author.username;
    const prompt = stampPrompt(fullText, username, msg.createdAt);

    // Meta-agent routing
    const mappedNs = this.channelNamespaceMap.get(channelId);
    if (mappedNs && this.redis) {
      this.writeChatMessage("user", "discord", fullText, channelId, mappedNs.namespace);
      this.opts.registerRoutedChannelId?.(mappedNs.namespace, channelId);
      this.persistChannelMapping(channelId, mappedNs.namespace, mappedNs.repoUrl);
      this.startMetaAgentTyping(channelId, channel);
      try {
        await routeToMetaAgent(mappedNs.namespace, prompt, this.redis);
      } catch (err) {
        await (channel as TextChannel).send(`Failed to route to ${mappedNs.namespace}: ${(err as Error).message}`).catch(() => {});
      }
      return;
    }

    // Local Claude session
    const session = this.getOrCreateSession(channelId, channel);
    try {
      session.currentPrompt = fullText;
      session.claude.sendPrompt(prompt);
      this.startTyping(channelId, channel, session);
      this.writeChatMessage("user", "discord", fullText, channelId);
    } catch (err) {
      await (channel as TextChannel).send(`Failed to process file: ${(err as Error).message}`).catch(() => {});
    }
  }

  private getOrCreateSession(channelId: string, channel: SendableChannel): Session {
    const key = this.sessionKey(channelId);
    let session = this.sessions.get(key);

    if (session && !session.claude.exited) return session;
    if (session) {
      // Process exited — clean up
      if (session.flushTimer) clearTimeout(session.flushTimer);
      if (session.typingTimer) clearInterval(session.typingTimer);
    }

    const claude = new ClaudeProcess({
      cwd: this.opts.cwd ?? process.cwd(),
      token: this.opts.claudeToken ?? getCurrentToken(),
    });

    session = {
      claude,
      pendingText: "",
      flushTimer: null,
      typingTimer: null,
      writtenFiles: new Set(),
      currentPrompt: "",
    };

    claude.on("message", (msg: ClaudeMessage) => {
      void this.onClaudeMessage(channelId, channel, session!, msg);
    });

    claude.on("usage", (usage: UsageEvent) => {
      this.addUsage(channelId, usage);
    });

    claude.on("error", (err: Error) => {
      console.error(`[claude:${channelId}] error:`, err.message);
    });

    claude.on("exit", (code) => {
      console.log(`[claude:${channelId}] process exited (code=${code})`);
      if (session!.typingTimer) {
        clearInterval(session!.typingTimer);
        session!.typingTimer = null;
      }
    });

    this.sessions.set(key, session);
    return session;
  }

  private async onClaudeMessage(
    channelId: string,
    channel: SendableChannel,
    session: Session,
    msg: ClaudeMessage
  ): Promise<void> {
    if (msg.type === "assistant") {
      const text = extractText(msg);
      if (!text) return;

      // Detect file paths in output
      const filePathMatch = text.match(/(?:^|\n)\s*(?:file written|wrote file|created file|saved to|output:)\s*[:\-]?\s*(\/[^\s\n]+)/im);
      if (filePathMatch) {
        const filePath = filePathMatch[1].trim();
        if (existsSync(filePath)) {
          session.writtenFiles.add(filePath);
        }
      }

      // Accumulate streaming text and debounce flush
      session.pendingText += (session.pendingText ? "\n" : "") + text;
      if (session.flushTimer) clearTimeout(session.flushTimer);
      session.flushTimer = setTimeout(() => {
        void this.flushSession(channelId, channel, session);
      }, FLUSH_DELAY_MS);
    } else if (msg.type === "result") {
      // Final result — flush immediately
      if (session.flushTimer) {
        clearTimeout(session.flushTimer);
        session.flushTimer = null;
      }
      const resultText = extractText(msg);
      if (resultText && !session.pendingText) {
        session.pendingText = resultText;
      }
      await this.flushSession(channelId, channel, session);

      // Send any files written during this turn
      for (const filePath of session.writtenFiles) {
        if (existsSync(filePath)) {
          try {
            const attachment = new AttachmentBuilder(filePath, { name: basename(filePath) });
            await (channel as TextChannel).send({ files: [attachment] });
          } catch (err) {
            console.warn(`[bot] failed to send file ${filePath}:`, (err as Error).message);
          }
        }
      }
      session.writtenFiles.clear();

      // Stop typing indicator
      if (session.typingTimer) {
        clearInterval(session.typingTimer);
        session.typingTimer = null;
      }

      this.getCost(channelId).messageCount++;
    }
  }

  private async flushSession(channelId: string, channel: SendableChannel, session: Session): Promise<void> {
    const text = stripAnsi(session.pendingText.trim());
    session.pendingText = "";
    session.flushTimer = null;
    if (!text) return;

    // Use source="discord" so the notifier's pmessage guard (source !== "claude") drops it
    // and does not re-send this message as a second Discord notification.
    this.writeChatMessage("assistant", "discord", text, channelId);
    await this.sendToChannel(channel, text);
  }

  private startTyping(channelId: string, channel: SendableChannel, session: Session): void {
    if (session.typingTimer) return; // already running
    // Send immediately
    (channel as TextChannel).sendTyping().catch(() => {});
    session.typingTimer = setInterval(() => {
      (channel as TextChannel).sendTyping().catch(() => {});
    }, TYPING_INTERVAL_MS);
  }

  private killSession(channelId: string): void {
    const key = this.sessionKey(channelId);
    const session = this.sessions.get(key);
    if (!session) return;
    if (session.flushTimer) clearTimeout(session.flushTimer);
    if (session.typingTimer) clearInterval(session.typingTimer);
    session.claude.kill();
    this.sessions.delete(key);
  }

  private getCost(channelId: string): SessionCost {
    let cost = this.costs.get(channelId);
    if (!cost) {
      cost = { totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadTokens: 0, totalCacheWriteTokens: 0, totalCostUsd: 0, messageCount: 0 };
      this.costs.set(channelId, cost);
    }
    return cost;
  }

  private addUsage(channelId: string, usage: UsageEvent): void {
    const cost = this.getCost(channelId);
    cost.totalInputTokens += usage.inputTokens;
    cost.totalOutputTokens += usage.outputTokens;
    cost.totalCacheReadTokens += usage.cacheReadTokens;
    cost.totalCacheWriteTokens += usage.cacheWriteTokens;
    cost.totalCostUsd += computeCostUsd(usage);
  }

  private buildCostEmbed(channelId: string): EmbedBuilder {
    const cost = this.getCost(channelId);
    const inputCost = cost.totalInputTokens * PRICING.inputPerM / 1_000_000;
    const outputCost = cost.totalOutputTokens * PRICING.outputPerM / 1_000_000;
    const cacheReadCost = cost.totalCacheReadTokens * PRICING.cacheReadPerM / 1_000_000;
    const cacheWriteCost = cost.totalCacheWriteTokens * PRICING.cacheWritePerM / 1_000_000;

    return new EmbedBuilder()
      .setTitle("Session Cost")
      .setColor(0x5865F2)
      .addFields(
        { name: "Messages", value: String(cost.messageCount), inline: true },
        { name: "Total", value: `$${cost.totalCostUsd.toFixed(3)}`, inline: true },
        { name: "\u200B", value: "\u200B", inline: false },
        { name: "Input", value: `${formatTokens(cost.totalInputTokens)} tokens ($${inputCost.toFixed(3)})`, inline: true },
        { name: "Output", value: `${formatTokens(cost.totalOutputTokens)} tokens ($${outputCost.toFixed(3)})`, inline: true },
        { name: "Cache Read", value: `${formatTokens(cost.totalCacheReadTokens)} tokens ($${cacheReadCost.toFixed(3)})`, inline: true },
        { name: "Cache Write", value: `${formatTokens(cost.totalCacheWriteTokens)} tokens ($${cacheWriteCost.toFixed(3)})`, inline: true },
      );
  }

  private async registerSlashCommands(): Promise<void> {
    const commands = [
      new SlashCommandBuilder().setName("reset").setDescription("Reset Claude session for this channel"),
      new SlashCommandBuilder().setName("costs").setDescription("Show token usage and cost for this channel"),
      new SlashCommandBuilder().setName("mcp_status").setDescription("Check MCP server connection status"),
      new SlashCommandBuilder()
        .setName("crons")
        .setDescription("Manage cron jobs")
        .addSubcommand((sub) =>
          sub.setName("list").setDescription("List cron jobs for this channel")
        )
        .addSubcommand((sub) =>
          sub.setName("add")
            .setDescription("Add a cron job")
            .addStringOption((opt) => opt.setName("schedule").setDescription("Schedule (e.g. every 1h)").setRequired(true))
            .addStringOption((opt) => opt.setName("prompt").setDescription("Prompt to send").setRequired(true))
        )
        .addSubcommand((sub) =>
          sub.setName("remove")
            .setDescription("Remove a cron job")
            .addStringOption((opt) => opt.setName("id").setDescription("Job ID").setRequired(true))
        )
        .addSubcommand((sub) =>
          sub.setName("clear").setDescription("Clear all cron jobs for this channel")
        ),
      new SlashCommandBuilder()
        .setName("wiki")
        .setDescription("Wiki page info (pass namespace to look up)")
        .addStringOption((opt) => opt.setName("namespace").setDescription("Namespace to look up").setRequired(false)),
      new SlashCommandBuilder()
        .setName("channel")
        .setDescription("Create a Discord channel for a GitHub repo meta-agent")
        .addStringOption((opt) =>
          opt.setName("repo").setDescription("GitHub repo URL (e.g. https://github.com/org/repo)").setRequired(true)
        ),
      new SlashCommandBuilder()
        .setName("restart")
        .setDescription("Graceful restart — exits this process (launchd will respawn clean)"),
      new SlashCommandBuilder()
        .setName("clear")
        .setDescription("Clear the Claude session context for this channel's namespace"),
      new SlashCommandBuilder()
        .setName("compact")
        .setDescription("Compact the Claude session context for this channel's namespace"),
      new SlashCommandBuilder()
        .setName("cron")
        .setDescription("Manage Redis-persisted cron jobs for this channel's namespace")
        .addSubcommand((sub) =>
          sub
            .setName("add")
            .setDescription("Add a cron job (standard 5-field cron expression)")
            .addStringOption((opt) =>
              opt.setName("schedule").setDescription("Cron expression e.g. '0 * * * *'").setRequired(true)
            )
            .addStringOption((opt) =>
              opt.setName("message").setDescription("Message to push to the meta-agent input queue").setRequired(true)
            )
            .addIntegerOption((opt) =>
              opt.setName("compact_every").setDescription("Push /compact every N fires (default: 10, 0 = never)").setRequired(false)
            )
        )
        .addSubcommand((sub) =>
          sub.setName("list").setDescription("List all cron jobs")
        )
        .addSubcommand((sub) =>
          sub
            .setName("pause")
            .setDescription("Pause a cron job")
            .addStringOption((opt) => opt.setName("id").setDescription("Cron ID").setRequired(true))
        )
        .addSubcommand((sub) =>
          sub
            .setName("resume")
            .setDescription("Resume a paused cron job")
            .addStringOption((opt) => opt.setName("id").setDescription("Cron ID").setRequired(true))
        )
        .addSubcommand((sub) =>
          sub
            .setName("delete")
            .setDescription("Delete a cron job permanently")
            .addStringOption((opt) => opt.setName("id").setDescription("Cron ID").setRequired(true))
        ),
    ].map((cmd) => cmd.toJSON());

    const rest = new REST().setToken(this.opts.discordToken);

    if (this.opts.guildIds?.length) {
      for (const guildId of this.opts.guildIds) {
        try {
          const appId = this.client.application?.id;
          if (!appId) {
            console.warn("[discord] application ID not available yet");
            return;
          }
          await rest.put(Routes.applicationGuildCommands(appId, guildId), { body: commands });
          console.log(`[discord] slash commands registered for guild ${guildId}`);
        } catch (err) {
          console.error(`[discord] slash command registration failed for guild ${guildId}:`, (err as Error).message);
        }
      }
    } else {
      // Global commands (can take up to 1hr to propagate)
      try {
        const appId = this.client.application?.id;
        if (!appId) {
          console.warn("[discord] application ID not available yet");
          return;
        }
        await rest.put(Routes.applicationCommands(appId), { body: commands });
        console.log("[discord] slash commands registered globally");
      } catch (err) {
        console.error("[discord] global slash command registration failed:", (err as Error).message);
      }
    }
  }

  private async handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const channelId = interaction.channelId;
    const userId = interaction.user.id;

    if (!this.isAllowed(userId)) {
      await interaction.reply({ content: "Not authorized.", ephemeral: true });
      return;
    }

    this.lastActiveChannelId = channelId;

    switch (interaction.commandName) {
      case "reset": {
        this.killSession(channelId);
        await interaction.reply("Session reset. Send a message to start.");
        break;
      }

      case "costs": {
        const embed = this.buildCostEmbed(channelId);
        await interaction.reply({ embeds: [embed] });
        break;
      }

      case "mcp_status": {
        await interaction.deferReply();
        try {
          const result = await this.callCcAgentTool("get_version");
          await interaction.editReply(result ? `MCP connected. Version: ${result}` : "MCP connected (no version info).");
        } catch (err) {
          await interaction.editReply(`MCP unavailable: ${(err as Error).message}`);
        }
        break;
      }

      case "crons": {
        await this.handleCronsCommand(interaction, channelId);
        break;
      }

      case "wiki": {
        await interaction.deferReply();
        const ns = interaction.options.getString("namespace") ?? this.namespace;
        try {
          const result = await this.callCcAgentTool("get_wiki", { namespace: ns });
          if (result) {
            const chunks = splitLongMessage(result);
            await interaction.editReply(chunks[0]);
            for (const chunk of chunks.slice(1)) {
              await interaction.followUp(chunk);
            }
          } else {
            await interaction.editReply("No wiki content found.");
          }
        } catch (err) {
          await interaction.editReply(`Wiki lookup failed: ${(err as Error).message}`);
        }
        break;
      }

      case "channel": {
        const repoUrl = interaction.options.getString("repo", true);
        const urlMatch = repoUrl.match(/^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)/i);
        if (!urlMatch) {
          await interaction.reply({ content: "Invalid repo URL. Use: https://github.com/org/repo", ephemeral: true });
          return;
        }
        const namespace = urlMatch[2];
        const guild = interaction.guild;
        if (!guild) {
          await interaction.reply({ content: "Channel creation requires a guild (not available in DMs).", ephemeral: true });
          return;
        }
        await interaction.deferReply();
        try {
          const newChannel = await guild.channels.create({ name: namespace, type: ChannelType.GuildText, parent: resolveCategoryId(guild) }) as TextChannel;
          this.channelNamespaceMap.set(newChannel.id, { namespace, repoUrl });
          this.opts.registerRoutedChannelId?.(namespace, newChannel.id);
          this.persistChannelMapping(newChannel.id, namespace, repoUrl);
          await interaction.editReply(`Created <#${newChannel.id}> — messages there route to the ${repoUrl} meta-agent`);
          // Clone workspace and inject MCP config in the background
          this.metaAgentManager.ensureWorkspace(namespace, repoUrl)
            .then(async () => {
              const token = await this.resolveToken();
              this.metaAgentManager.injectMcp(namespace, token);
            })
            .catch((err: Error) => {
              console.error(`[bot] /channel workspace setup(${namespace}) failed:`, err.message);
              this.sendToChannelById(newChannel.id, `Warning: workspace setup failed — ${err.message}`).catch(() => {});
            });
        } catch (err) {
          await interaction.editReply(`Failed to create channel: ${(err as Error).message}`);
        }
        break;
      }

      case "restart": {
        await interaction.reply("Restarting...");
        setTimeout(() => { process.exit(0); }, 500);
        break;
      }

      case "clear": {
        const ns = this.resolveNamespaceForChannel(channelId);
        const deleted = this.clearClaudeSession(ns);
        await interaction.reply(
          deleted > 0
            ? `Context cleared for ${ns} (${deleted} session file${deleted === 1 ? "" : "s"} removed). Next message starts fresh.`
            : `No active session files found for ${ns}.`
        );
        break;
      }

      case "compact": {
        const ns = this.resolveNamespaceForChannel(channelId);
        await interaction.reply(`Compacting context for ${ns}...`);
        this.compactClaudeSession(ns).catch((err: Error) => {
          console.warn(`[bot] /compact failed (ns=${ns}):`, err.message);
        });
        break;
      }

      case "cron": {
        await this.handleCronEngineCommand(interaction, channelId);
        break;
      }
    }
  }

  private async handleCronsCommand(interaction: ChatInputCommandInteraction, channelId: string): Promise<void> {
    const sub = interaction.options.getSubcommand();
    const chatIdNum = this.storeSnowflake(channelId);

    switch (sub) {
      case "list": {
        const jobs = this.cron.list(chatIdNum);
        if (jobs.length === 0) {
          await interaction.reply("No cron jobs for this channel.");
        } else {
          const lines = jobs.map((j) => {
            const chanId = this.reverseSnowflakeLookup(j.chatId);
            const chanMention = chanId ? ` <#${chanId}>` : "";
            return `• **${j.id}**${chanMention} ${j.schedule}: \`${j.prompt}\``;
          });
          await interaction.reply(lines.join("\n"));
        }
        break;
      }
      case "add": {
        const schedule = interaction.options.getString("schedule", true);
        const prompt = interaction.options.getString("prompt", true);
        const job = this.cron.add(chatIdNum, schedule, prompt);
        if (!job) {
          await interaction.reply("Invalid schedule. Use format: `every 30m`, `every 2h`, `every 1d`");
        } else {
          await interaction.reply(`Cron job added: **${job.id}** (${job.schedule})`);
        }
        break;
      }
      case "remove": {
        const id = interaction.options.getString("id", true);
        const removed = this.cron.remove(chatIdNum, id);
        await interaction.reply(removed ? `Removed cron job ${id}.` : `Job ${id} not found.`);
        break;
      }
      case "clear": {
        const count = this.cron.clearAll(chatIdNum);
        await interaction.reply(`Cleared ${count} cron job(s).`);
        break;
      }
      default:
        await interaction.reply("Unknown subcommand.");
    }
  }

  /**
   * Handle the /cron command group — backed by CronEngine (Redis-persisted, node-cron scheduled).
   * Namespace is derived from the channel's registered namespace (same pattern as /clear and /compact).
   */
  private async handleCronEngineCommand(interaction: ChatInputCommandInteraction, channelId: string): Promise<void> {
    if (!this.cronEngine) {
      await interaction.reply({ content: "Cron engine unavailable (no Redis connection).", ephemeral: true });
      return;
    }

    const ns = this.resolveNamespaceForChannel(channelId);
    const sub = interaction.options.getSubcommand();

    switch (sub) {
      case "add": {
        const cronSchedule = interaction.options.getString("schedule", true);
        const message = interaction.options.getString("message", true);
        const compactEvery = interaction.options.getInteger("compact_every") ?? 10;
        await interaction.deferReply();
        const rec = await this.cronEngine.add(ns, cronSchedule, message, compactEvery);
        if (!rec) {
          await interaction.editReply(
            `Invalid cron expression: \`${cronSchedule}\`\nUse standard 5-field format, e.g. \`0 * * * *\` (hourly) or \`*/30 * * * *\` (every 30 min).`
          );
        } else {
          await interaction.editReply(
            `Cron added for namespace **${ns}**\nID: \`${rec.id}\`\nSchedule: \`${rec.schedule}\`\nCompact every: ${rec.compact_every} fires`
          );
        }
        break;
      }

      case "list": {
        await interaction.deferReply();
        const allCrons = await this.cronEngine.list();
        const nsCrons = allCrons.filter((r) => r.namespace === ns);
        if (nsCrons.length === 0) {
          await interaction.editReply(`No cron jobs for namespace **${ns}**.`);
        } else {
          const embed = new EmbedBuilder()
            .setTitle(`Cron jobs — ${ns}`)
            .setColor(0x5865F2)
            .setDescription(
              nsCrons
                .map((r) => {
                  const status = r.enabled ? "enabled" : "paused";
                  const last = r.last_fired_at ? `last fired ${r.last_fired_at}` : "never fired";
                  return `**\`${r.id}\`** [${status}]\nSchedule: \`${r.schedule}\` | Fires: ${r.fire_count} | ${last}\nMessage: \`${r.message.slice(0, 80)}${r.message.length > 80 ? "…" : ""}\``;
                })
                .join("\n\n")
            );
          await interaction.editReply({ embeds: [embed] });
        }
        break;
      }

      case "pause": {
        const id = interaction.options.getString("id", true);
        await interaction.deferReply();
        const ok = await this.cronEngine.pause(id);
        await interaction.editReply(ok ? `Cron \`${id}\` paused.` : `Cron \`${id}\` not found.`);
        break;
      }

      case "resume": {
        const id = interaction.options.getString("id", true);
        await interaction.deferReply();
        const ok = await this.cronEngine.resume(id);
        await interaction.editReply(ok ? `Cron \`${id}\` resumed.` : `Cron \`${id}\` not found.`);
        break;
      }

      case "delete": {
        const id = interaction.options.getString("id", true);
        await interaction.deferReply();
        const ok = await this.cronEngine.delete(id);
        await interaction.editReply(ok ? `Cron \`${id}\` deleted.` : `Cron \`${id}\` not found.`);
        break;
      }

      default:
        await interaction.reply("Unknown /cron subcommand.");
    }
  }

  /**
   * Call a cc-agent MCP tool via a dedicated ClaudeProcess.
   * Returns the tool result as a string, or null on failure.
   */
  public async callCcAgentTool(toolName: string, args: Record<string, unknown> = {}): Promise<string | null> {
    return new Promise((resolve) => {
      const prompt = `Use the ${toolName} tool with these arguments: ${JSON.stringify(args)}. Return only the raw result, no extra commentary.`;

      const claude = new ClaudeProcess({
        cwd: this.opts.cwd ?? process.cwd(),
        token: this.opts.claudeToken ?? getCurrentToken(),
      });

      let result = "";
      const timeout = setTimeout(() => {
        claude.kill();
        resolve(null);
      }, 30_000);

      claude.on("message", (msg: ClaudeMessage) => {
        if (msg.type === "result") {
          result = extractText(msg) || result;
        } else if (msg.type === "assistant") {
          result += extractText(msg);
        }
      });

      claude.on("exit", () => {
        clearTimeout(timeout);
        resolve(result.trim() || null);
      });

      claude.on("error", () => {
        clearTimeout(timeout);
        resolve(null);
      });

      claude.sendPrompt(prompt);
    });
  }

  private runCronTask(channelId: string, prompt: string, done: () => void): void {
    const getChannel = this.getChannel.bind(this);

    void (async () => {
      const channel = await getChannel(channelId);
      if (!channel) {
        console.warn(`[cron] channel ${channelId} not found`);
        done();
        return;
      }

      const session = this.getOrCreateSession(channelId, channel);
      try {
        session.currentPrompt = prompt;
        session.claude.sendPrompt(stampPrompt(prompt));
        this.startTyping(channelId, channel, session);

        // Listen for result to call done()
        const onExit = (): void => { done(); };
        session.claude.once("exit", onExit);
      } catch (err) {
        console.error(`[cron:${channelId}] error:`, (err as Error).message);
        done();
      }
    })();
  }

  /**
   * Create a new Discord text channel for `namespace`, register it in channelNamespaceMap,
   * and start the meta-agent for `repoUrl`. Fire-and-forget after sending the confirmation message.
   */
  private async createChannelForRepo(msg: Message, namespace: string, repoUrl: string): Promise<void> {
    const channel = msg.channel as SendableChannel;
    const guild = msg.guild;
    if (!guild) {
      await (channel as TextChannel).send("Channel creation requires a guild (not available in DMs).").catch(() => {});
      return;
    }
    let newChannel: TextChannel;
    try {
      newChannel = await guild.channels.create({ name: namespace, type: ChannelType.GuildText, parent: resolveCategoryId(guild) }) as TextChannel;
    } catch (err) {
      await (channel as TextChannel).send(`Failed to create channel: ${(err as Error).message}`).catch(() => {});
      return;
    }
    this.channelNamespaceMap.set(newChannel.id, { namespace, repoUrl });
    this.opts.registerRoutedChannelId?.(namespace, newChannel.id);
    this.persistChannelMapping(newChannel.id, namespace, repoUrl);
    await (channel as TextChannel).send(`Created <#${newChannel.id}> — messages there route to the ${repoUrl} meta-agent`).catch(() => {});
    // Clone workspace and inject MCP config in the background after acknowledging the user
    this.metaAgentManager.ensureWorkspace(namespace, repoUrl)
      .then(async () => {
        const token = await this.resolveToken();
        this.metaAgentManager.injectMcp(namespace, token);
      })
      .catch((err: Error) => {
        console.error(`[bot] workspace setup(${namespace}) failed:`, err.message);
        this.sendToChannelById(newChannel.id, `Warning: workspace setup failed — ${err.message}`).catch(() => {});
      });
  }

  /** Write a message to the Redis chat log. Fire-and-forget.
   *  Pass `ns` to write under a specific namespace; defaults to the bot's primary namespace. */
  private writeChatMessage(role: ChatMessage["role"], source: ChatMessage["source"], content: string, channelId: string, ns?: string): void {
    if (!this.redis) return;
    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      source,
      role,
      content,
      timestamp: new Date().toISOString(),
      chatId: snowflakeToInt(channelId),
    };
    writeChatLog(this.redis, ns ?? this.namespace, msg);
  }

  /** Returns the last channelId that sent a message. */
  public getLastActiveChannelId(): string | undefined {
    return this.lastActiveChannelId;
  }

  /** Reverse lookup: find the Discord channelId registered for a given namespace. */
  public getChannelIdForNamespace(ns: string): string | undefined {
    for (const [channelId, mapping] of this.channelNamespaceMap) {
      if (mapping.namespace === ns) return channelId;
    }
    return undefined;
  }

  /** Return the thread ID for an active loop on `channelId`, or undefined. */
  public getLoopThreadId(channelId: string): string | undefined {
    return this.loopManager?.getThreadId(channelId);
  }

  /**
   * Post a structured eval-report embed to the loop thread for `channelId`.
   * Also records gate failures in the LoopManager if the gate did not pass.
   */
  public async postEvalEmbed(channelId: string, report: EvalReport): Promise<void> {
    const threadId = this.loopManager?.getThreadId(channelId);
    if (!threadId) return;
    const channel = await this.getChannel(threadId);
    if (!channel) return;

    const color = report.passed ? 0x57F287 : 0xED4245; // green / red
    const embed = new EmbedBuilder()
      .setTitle(`${report.passed ? "✅" : "❌"} Gate: ${report.gate}`)
      .setColor(color)
      .addFields(
        { name: "Result", value: report.passed ? "PASSED" : "FAILED", inline: true },
        { name: "Confidence", value: `${(report.confidence * 100).toFixed(0)}%`, inline: true },
        { name: "Iteration", value: `${report.iteration} / ${report.maxIterations}`, inline: true },
        { name: "Feedback", value: report.feedback || "(none)", inline: false },
      )
      .setTimestamp();

    await (channel as TextChannel).send({ embeds: [embed] }).catch((err: Error) => {
      console.warn(`[bot] postEvalEmbed send failed:`, err.message);
    });

    if (!report.passed && this.loopManager) {
      await this.loopManager.addGateFailure(channelId, {
        gate: report.gate,
        feedback: report.feedback,
        iteration: report.iteration,
        confidence: report.confidence,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Create a Discord thread on `msg`, register loop state, and add reaction gates.
   * Requires MANAGE_THREADS permission. Falls back silently on failure.
   */
  private async createLoopThread(
    msg: Message,
    channelId: string,
    namespace: string,
    goal: string
  ): Promise<void> {
    try {
      const shortGoal = goal.slice(0, 48).replace(/\s+/g, " ");
      const threadName = `Goal: ${shortGoal}${goal.length > 48 ? "…" : ""}`;
      const thread = await (msg.channel as TextChannel).threads.create({
        name: threadName,
        autoArchiveDuration: 10080, // 1 week
        startMessage: msg,
        reason: "Loop observability thread",
      });

      const firstMsg = await thread.send(
        `🎯 **Loop tracking thread**\n> ${goal.slice(0, 200)}\n\nReact to control the loop:\n` +
        `🔄 Retry current iteration  ✅ Accept & exit  ❌ Kill loop`
      );
      await firstMsg.react("🔄");
      await firstMsg.react("✅");
      await firstMsg.react("❌");

      await this.loopManager!.startLoop(channelId, thread.id, firstMsg.id, namespace, goal);
      console.log(`[bot] loop thread created: channelId=${channelId} threadId=${thread.id}`);
    } catch (err) {
      console.warn(`[bot] createLoopThread failed:`, (err as Error).message);
    }
  }

  /** Handle 🔄/✅/❌ reactions on loop gate messages. */
  private async handleReactionAdd(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser
  ): Promise<void> {
    if (user.bot) return;
    if (!this.isAllowed(user.id)) return;
    if (!this.loopManager || !this.redis) return;

    // Fetch full reaction object if partial (bot doesn't have it cached)
    let fullReaction = reaction;
    if (reaction.partial) {
      try {
        fullReaction = await reaction.fetch();
      } catch {
        return;
      }
    }

    const emoji = fullReaction.emoji.name;
    if (emoji !== "🔄" && emoji !== "✅" && emoji !== "❌") return;

    const messageId = fullReaction.message.id;
    const channelId = this.loopManager.getChannelIdByReactionMessage(messageId);
    if (!channelId) return;

    const loopState = this.loopManager.getState(channelId);
    if (!loopState) return;

    const thread = await this.getChannel(loopState.threadId);

    if (emoji === "🔄") {
      if (thread) {
        await (thread as ThreadChannel).send(
          `🔄 Retry requested — re-running iteration ${loopState.iteration + 1}`
        ).catch(() => {});
      }
      try {
        await routeToMetaAgent(
          loopState.namespace,
          `Please retry the previous goal: ${loopState.goal}`,
          this.redis
        );
      } catch (err) {
        console.warn(`[bot] retry routeToMetaAgent failed:`, (err as Error).message);
      }
    } else if (emoji === "✅") {
      if (thread) {
        await (thread as ThreadChannel).send("✅ Loop accepted — marking complete").catch(() => {});
      }
      await this.sendToChannelById(channelId, `✅ Goal completed: ${loopState.goal.slice(0, 100)}`);
      await this.loopManager.endLoop(channelId);
      if (thread && thread.isThread()) {
        await thread.setArchived(true).catch(() => {});
      }
    } else if (emoji === "❌") {
      if (thread) {
        await (thread as ThreadChannel).send("❌ Loop killed by user").catch(() => {});
      }
      await this.sendToChannelById(channelId, `❌ Loop killed: ${loopState.goal.slice(0, 100)}`);
      await this.loopManager.endLoop(channelId);
      if (thread && thread.isThread()) {
        await thread.setArchived(true).catch(() => {});
      }
    }
  }

  /**
   * Feed a text message into the active Claude session for the given channel.
   * Called by the notifier when a UI message arrives via Redis pub/sub.
   */
  public async handleUserMessage(channelId: string, text: string): Promise<void> {
    const channel = await this.getChannel(channelId);
    if (!channel) {
      console.warn(`[bot] handleUserMessage: channel ${channelId} not found`);
      return;
    }
    const session = this.getOrCreateSession(channelId, channel);
    try {
      session.currentPrompt = text;
      session.claude.sendPrompt(stampPrompt(text));
      this.startTyping(channelId, channel, session);
      this.writeChatMessage("user", "ui", text, channelId);
    } catch (err) {
      await (channel as TextChannel).send(`Error sending to Claude: ${(err as Error).message}`).catch(() => {});
      this.killSession(channelId);
    }
  }

  /**
   * Forward a cc-agent job notification into an existing Claude session.
   * Unlike handleUserMessage, this never creates a new session.
   */
  public forwardNotification(channelId: string, text: string): void {
    const key = this.sessionKey(channelId);
    const session = this.sessions.get(key);
    if (!session || session.claude.exited) return;
    try {
      session.claude.sendPrompt(stampPrompt(text));
      this.writeChatMessage("user", "cc-discord", text, channelId);
    } catch (err) {
      console.error(`[forwardNotification:${channelId}] failed:`, (err as Error).message);
    }
  }

  /** Resolve the current claude token from wire master or env fallbacks. */
  public async resolveToken(): Promise<string> {
    if (this.wire) {
      try {
        return await this.wire.token.getMaster();
      } catch {
        // master token not set — fall through to env vars
      }
    }
    return (
      this.opts.claudeToken ??
      process.env.CLAUDE_CODE_OAUTH_TOKEN ??
      process.env.CLAUDE_CODE_TOKEN ??
      process.env.ANTHROPIC_API_KEY ??
      ""
    );
  }

  /**
   * Start the meta-agent polling loop.
   * Called from index.ts after startup migrations complete.
   * Passes a live getter for the set of registered namespaces.
   */
  public startMetaAgentPolling(): void {
    if (!this.wire) return;
    this.metaAgentManager.startPolling(
      this.wire,
      () => Array.from(this.channelNamespaceMap.values()),
      this.opts.instanceId
    );
  }

  /**
   * Start the CronEngine — loads all enabled crons from Redis and schedules them.
   * Called from index.ts after startup migrations complete (alongside startMetaAgentPolling).
   */
  public startCronEngine(): void {
    if (!this.cronEngine) return;
    this.cronEngine.start().catch((err: Error) => {
      console.warn("[bot] cronEngine.start() failed:", err.message);
    });
  }

  /**
   * Resolve the namespace for a given channelId.
   * Routed channels use their registered namespace; everything else uses the bot's primary namespace.
   */
  private resolveNamespaceForChannel(channelId: string): string {
    return this.channelNamespaceMap.get(channelId)?.namespace ?? this.namespace;
  }

  /**
   * Delete all Claude session JSONL files for the given namespace's workspace.
   * Claude stores sessions in ~/.claude/projects/{encoded-workspace-path}/*.jsonl
   * The path encoding replaces / with - and prepends a leading -.
   * Returns the number of files deleted.
   */
  private clearClaudeSession(ns: string): number {
    const wsPath = join(homedir(), "cc-discord-workspace", ns);
    // Claude encodes workspace path: strip leading /, replace / with -, then prepend -
    const encoded = "-" + wsPath.slice(1).replace(/\//g, "-");
    const projectsDir = join(homedir(), ".claude", "projects", encoded);
    if (!existsSync(projectsDir)) return 0;
    let count = 0;
    try {
      const entries = readdirSync(projectsDir);
      for (const entry of entries) {
        if (entry.endsWith(".jsonl")) {
          rmSync(join(projectsDir, entry), { force: true });
          count++;
        }
      }
    } catch (err) {
      console.warn(`[bot] clearClaudeSession(${ns}) failed:`, (err as Error).message);
    }
    console.log(`[bot] clearClaudeSession(${ns}): deleted ${count} files from ${projectsDir}`);
    return count;
  }

  /**
   * Send /compact as a prompt to a one-shot claude --continue session in the namespace workspace.
   * This triggers Claude's built-in context compaction.
   */
  private async compactClaudeSession(ns: string): Promise<void> {
    const wsPath = join(homedir(), "cc-discord-workspace", ns);
    if (!existsSync(wsPath)) {
      console.warn(`[bot] compactClaudeSession(${ns}): workspace not found at ${wsPath}`);
      return;
    }
    const token = await this.resolveToken();
    const { spawn } = await import("child_process");
    const { existsSync: fsExists } = await import("fs");

    const resolveBin = (): string => {
      const dirs = (process.env.PATH ?? "").split(":");
      for (const dir of dirs) {
        const c = `${dir}/claude`;
        if (fsExists(c)) return c;
      }
      for (const p of [`${homedir()}/.npm-global/bin/claude`, "/opt/homebrew/bin/claude", "/usr/local/bin/claude"]) {
        if (fsExists(p)) return p;
      }
      return "claude";
    };

    const env: NodeJS.ProcessEnv = { ...process.env };
    if (token.startsWith("sk-ant-api")) {
      env.ANTHROPIC_API_KEY = token;
      delete env.CLAUDE_CODE_OAUTH_TOKEN;
    } else {
      env.CLAUDE_CODE_OAUTH_TOKEN = token;
      delete env.ANTHROPIC_API_KEY;
    }

    return new Promise((resolve) => {
      const proc = spawn(
        resolveBin(),
        ["--continue", "-p", "/compact", "--output-format", "text", "--dangerously-skip-permissions"],
        { cwd: wsPath, env, stdio: ["ignore", "pipe", "pipe"] }
      );
      proc.on("exit", (code) => {
        console.log(`[bot] compactClaudeSession(${ns}) exited code=${code}`);
        resolve();
      });
      proc.on("error", (err) => {
        console.warn(`[bot] compactClaudeSession(${ns}) spawn error:`, err.message);
        resolve();
      });
    });
  }

  public stop(): void {
    for (const [key, session] of this.sessions) {
      if (session.flushTimer) clearTimeout(session.flushTimer);
      if (session.typingTimer) clearInterval(session.typingTimer);
      session.claude.kill();
      this.sessions.delete(key);
    }
    for (const [channelId] of this.metaAgentTypingTimers) {
      this.stopMetaAgentTyping(channelId);
    }
    this.metaAgentManager.stop();
    void this.client.destroy();
  }
}
