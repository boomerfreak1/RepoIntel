import { DocumentParser, ParsedDocument, ParsedSection } from "./types";

/**
 * Parser for .md files.
 * Uses regex-based heading extraction (avoids ESM-only remark issues).
 * Splits on ATX headings (# through ######).
 */

export const markdownParser: DocumentParser = {
  extensions: [".md"],

  async parse(buffer: Buffer, filePath: string): Promise<ParsedDocument> {
    const text = buffer.toString("utf-8");
    const sections = extractMarkdownSections(text);

    const fileName = filePath.split("/").pop() ?? filePath;
    const title =
      sections.find((s) => s.level >= 1)?.title ??
      fileName.replace(/\.md$/i, "");

    return {
      filePath,
      format: "md",
      title,
      rawText: text,
      sections,
      metadata: {
        lineCount: text.split("\n").length,
      },
    };
  },
};

function extractMarkdownSections(text: string): ParsedSection[] {
  const lines = text.split("\n");
  const sections: ParsedSection[] = [];
  const headingRegex = /^(#{1,6})\s+(.+)$/;

  let currentTitle = "(Preamble)";
  let currentLevel = 0;
  let currentLines: string[] = [];

  function flushSection() {
    const content = currentLines.join("\n").trim();
    if (content || currentLevel > 0) {
      sections.push({
        title: currentTitle,
        level: currentLevel,
        content,
      });
    }
  }

  for (const line of lines) {
    const match = headingRegex.exec(line);
    if (match) {
      flushSection();
      currentLevel = match[1].length;
      currentTitle = match[2].trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  flushSection();

  return sections;
}
