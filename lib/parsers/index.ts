import { DocumentParser, ParsedDocument } from "./types";
import { docxParser } from "./docx";
import { xlsxParser } from "./xlsx";
import { csvParser } from "./csv";
import { markdownParser } from "./markdown";
import { pdfParser } from "./pdf";
import path from "path";

export type { ParsedDocument, ParsedSection, DocumentParser } from "./types";

const parsers: DocumentParser[] = [
  docxParser,
  xlsxParser,
  csvParser,
  markdownParser,
  pdfParser,
];

/**
 * Get the appropriate parser for a file based on its extension.
 */
export function getParser(filePath: string): DocumentParser | null {
  const ext = path.extname(filePath).toLowerCase();
  return parsers.find((p) => p.extensions.includes(ext)) ?? null;
}

/**
 * Parse a document buffer, auto-detecting format from file extension.
 */
export async function parseDocument(
  buffer: Buffer,
  filePath: string
): Promise<ParsedDocument> {
  const parser = getParser(filePath);
  if (!parser) {
    throw new Error(
      `No parser available for file: ${filePath} (supported: ${parsers.flatMap((p) => p.extensions).join(", ")})`
    );
  }
  return parser.parse(buffer, filePath);
}

/**
 * Check if a file path is parseable.
 */
export function isSupported(filePath: string): boolean {
  return getParser(filePath) !== null;
}

export const supportedExtensions = parsers.flatMap((p) => p.extensions);
