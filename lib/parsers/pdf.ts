import { DocumentParser, ParsedDocument, ParsedSection } from "./types";

async function loadPdfParse(buffer: Buffer): Promise<{ text: string; numpages: number; info?: Record<string, unknown> }> {
  const mod = await import("pdf-parse");
  const fn = (mod as unknown as { default: (buf: Buffer) => Promise<{ text: string; numpages: number; info?: Record<string, unknown> }> }).default;
  return fn(buffer);
}

/**
 * Parser for .pdf files using pdf-parse.
 * Extracts text per page. Attempts heading detection from formatting cues.
 */

export const pdfParser: DocumentParser = {
  extensions: [".pdf"],

  async parse(buffer: Buffer, filePath: string): Promise<ParsedDocument> {
    const data = await loadPdfParse(buffer);

    // Split by page using form feed characters that pdf-parse inserts
    const pages = data.text.split(/\f/).filter((p) => p.trim());

    const sections: ParsedSection[] = [];

    for (let i = 0; i < pages.length; i++) {
      const pageText = pages[i].trim();
      if (!pageText) continue;

      // Try to detect headings: lines that are short, all-caps, or followed by blank lines
      const pageSections = extractPageSections(pageText, i + 1);
      sections.push(...pageSections);
    }

    // If no structure was detected, fall back to page-level sections
    if (sections.length === 0 && data.text.trim()) {
      for (let i = 0; i < pages.length; i++) {
        const pageText = pages[i].trim();
        if (!pageText) continue;
        sections.push({
          title: `Page ${i + 1}`,
          level: 1,
          content: pageText,
        });
      }
    }

    const fileName = filePath.split("/").pop() ?? filePath;

    return {
      filePath,
      format: "pdf",
      title: (data.info?.Title as string) ?? fileName.replace(/\.pdf$/i, ""),
      rawText: data.text,
      sections,
      metadata: {
        pageCount: data.numpages,
        info: data.info,
      },
    };
  },
};

/**
 * Attempt to extract sub-sections from a single page.
 * Detects headings heuristically: short lines (<80 chars) followed by longer content.
 */
function extractPageSections(
  pageText: string,
  pageNumber: number
): ParsedSection[] {
  const lines = pageText.split("\n");
  const sections: ParsedSection[] = [];
  let currentTitle = `Page ${pageNumber}`;
  let currentLines: string[] = [];
  let currentLevel = 1;

  for (const line of lines) {
    const trimmed = line.trim();

    // Heuristic: a heading is a short non-empty line (<80 chars)
    // that is either ALL CAPS or title-cased, and not a list item
    if (
      trimmed.length > 0 &&
      trimmed.length < 80 &&
      !trimmed.startsWith("-") &&
      !trimmed.startsWith("•") &&
      !trimmed.match(/^\d+\./) &&
      (isAllCaps(trimmed) || isTitleCase(trimmed)) &&
      !trimmed.endsWith(",") &&
      !trimmed.endsWith(";")
    ) {
      // Flush previous
      if (currentLines.length > 0) {
        const content = currentLines.join("\n").trim();
        if (content) {
          sections.push({
            title: currentTitle,
            level: currentLevel,
            content,
          });
        }
      }

      currentTitle = trimmed;
      currentLevel = isAllCaps(trimmed) ? 1 : 2;
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  // Flush remaining
  const content = currentLines.join("\n").trim();
  if (content) {
    sections.push({
      title: currentTitle,
      level: currentLevel,
      content,
    });
  }

  return sections;
}

function isAllCaps(text: string): boolean {
  const letters = text.replace(/[^a-zA-Z]/g, "");
  return letters.length > 2 && letters === letters.toUpperCase();
}

function isTitleCase(text: string): boolean {
  const words = text.split(/\s+/).filter((w) => w.length > 3);
  if (words.length < 2) return false;
  return words.every(
    (w) => w[0] === w[0].toUpperCase() || w.length <= 3
  );
}
