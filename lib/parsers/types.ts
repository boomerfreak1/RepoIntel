/**
 * Shared types for all document parsers.
 */

export interface ParsedSection {
  /** Heading or section title (e.g., "Workflow 1: Campaign Planning") */
  title: string;
  /** Depth level: 1 = top heading, 2 = subheading, etc. */
  level: number;
  /** Raw text content of this section (excluding the heading itself) */
  content: string;
}

export interface ParsedDocument {
  /** Original file path */
  filePath: string;
  /** File format */
  format: "docx" | "xlsx" | "csv" | "md" | "pdf";
  /** Document title if extractable, otherwise filename */
  title: string;
  /** Full raw text (all sections concatenated) */
  rawText: string;
  /** Structured sections with headings and hierarchy */
  sections: ParsedSection[];
  /** Format-specific metadata */
  metadata: Record<string, unknown>;
}

export interface DocumentParser {
  /** File extensions this parser handles */
  extensions: string[];
  /** Parse a document buffer into structured output */
  parse(buffer: Buffer, filePath: string): Promise<ParsedDocument>;
}
