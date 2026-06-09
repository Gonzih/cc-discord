/**
 * Discord markdown post-processor.
 * Discord renders standard markdown natively — no HTML escaping needed.
 * Headings become bold, lists use bullet characters.
 */

/**
 * Convert standard markdown text to Discord-friendly format.
 *
 * Discord renders most markdown natively (bold, italic, code blocks).
 * We only need to:
 * 1. Preserve fenced code blocks (``` ... ```) — Discord renders them
 * 2. Preserve inline code (`...`) — Discord renders it
 * 3. Convert ## headings → **Heading**
 * 4. Convert --- → blank line
 * 5. Leave **bold**, *italic*, _italic_ as-is (Discord handles them)
 */
export function formatForDiscord(text: string): string {
  const placeholders: string[] = [];

  // Step 1: Extract fenced code blocks — protect from further processing
  let out = text.replace(/```(?:\w*)\n?([\s\S]*?)```/g, (match) => {
    placeholders.push(match);
    return `\x00P${placeholders.length - 1}\x00`;
  });

  // Step 2: Extract inline code — protect from further processing
  out = out.replace(/`([^`\n]+)`/g, (match) => {
    placeholders.push(match);
    return `\x00P${placeholders.length - 1}\x00`;
  });

  // Step 3: Convert --- → blank line
  out = out.replace(/^-{3,}$/gm, "");

  // Step 4: Convert ## headings → **Heading**
  out = out.replace(/^#{1,6}\s+(.+)$/gm, "**$1**");

  // Step 5: Reinsert code blocks/inline code
  out = out.replace(/\x00P(\d+)\x00/g, (_, i) => placeholders[parseInt(i, 10)]);

  return out;
}

function findCodeBlockRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const re = /```[\s\S]*?```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}

function isInsideCodeBlock(pos: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([start, end]) => pos > start && pos < end);
}

/**
 * Split a long message at natural boundaries (paragraph > line > word).
 * Never splits inside code blocks. Chunks are at most maxLen characters.
 * Discord's limit is 2000 characters.
 */
export function splitLongMessage(text: string, maxLen = 2000): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    const slice = remaining.slice(0, maxLen);
    const codeRanges = findCodeBlockRanges(remaining);

    // Prefer paragraph boundary (\n\n)
    const lastPara = slice.lastIndexOf("\n\n");
    // Then line boundary (\n)
    const lastLine = slice.lastIndexOf("\n");
    // Then word boundary (space)
    const lastSpace = slice.lastIndexOf(" ");

    let splitAt: number;
    if (lastPara > 0 && !isInsideCodeBlock(lastPara, codeRanges)) {
      splitAt = lastPara + 2;
    } else if (lastLine > 0 && !isInsideCodeBlock(lastLine, codeRanges)) {
      splitAt = lastLine + 1;
    } else if (lastSpace > 0 && !isInsideCodeBlock(lastSpace, codeRanges)) {
      splitAt = lastSpace + 1;
    } else {
      // If all candidate split points are inside a code block, split after it
      const coveringBlock = codeRanges.find(([start, end]) => start < maxLen && end > maxLen);
      if (coveringBlock) {
        splitAt = coveringBlock[1];
      } else {
        splitAt = maxLen;
      }
    }

    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

/** Strip ANSI escape sequences from a string before sending to Discord. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B\[[0-9;]*[mGKHF]/g, "");
}
