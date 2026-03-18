import { ParsedDocument, ParsedSection } from "../parsers/types";

/**
 * Structure-aware document chunker.
 * Splits documents along natural boundaries (headings, sheets, pages)
 * rather than naive fixed-size token windows.
 */

export interface Chunk {
  /** Unique chunk identifier: `{docPath}#chunk-{index}` */
  id: string;
  /** Source document path */
  documentPath: string;
  /** Hierarchical section path (e.g., "Heading 1 > Subheading") */
  sectionPath: string;
  /** Section title for this chunk */
  sectionTitle: string;
  /** The actual text content */
  content: string;
  /** Zero-based chunk index within the document */
  chunkIndex: number;
  /** Estimated token count (rough: chars / 4) */
  tokenEstimate: number;
  /** Document format */
  format: string;
  /** Document title */
  documentTitle: string;
}

export interface ChunkerOptions {
  /** Max tokens per chunk (default: 512) */
  maxTokens?: number;
  /** Min tokens per chunk — small sections get merged with neighbors (default: 50) */
  minTokens?: number;
  /** Overlap tokens between split chunks (default: 50) */
  overlapTokens?: number;
}

const DEFAULT_OPTIONS: Required<ChunkerOptions> = {
  maxTokens: 512,
  minTokens: 50,
  overlapTokens: 50,
};

/**
 * Chunk a parsed document into indexable pieces.
 */
export function chunkDocument(
  doc: ParsedDocument,
  options?: ChunkerOptions
): Chunk[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const chunks: Chunk[] = [];

  if (doc.sections.length === 0) {
    // No sections — chunk the raw text directly
    const textChunks = splitText(doc.rawText, opts);
    for (let i = 0; i < textChunks.length; i++) {
      chunks.push(makeChunk(doc, "(Document)", "(Document)", textChunks[i], i));
    }
    return chunks;
  }

  // Build section path context for hierarchical breadcrumbs
  const sectionStack: Array<{ title: string; level: number }> = [];

  // Collect sections, merging small ones into neighbors
  const mergedSections = mergeSections(doc.sections, opts.minTokens);

  for (const section of mergedSections) {
    // Update the heading stack to build section paths
    while (
      sectionStack.length > 0 &&
      sectionStack[sectionStack.length - 1].level >= section.level
    ) {
      sectionStack.pop();
    }
    sectionStack.push({ title: section.title, level: section.level });

    const sectionPath = sectionStack.map((s) => s.title).join(" > ");

    if (!section.content.trim()) continue;

    const tokenEst = estimateTokens(section.content);

    if (tokenEst <= opts.maxTokens) {
      // Section fits in one chunk
      chunks.push(
        makeChunk(doc, sectionPath, section.title, section.content, chunks.length)
      );
    } else {
      // Section too large — split with overlap
      const textChunks = splitText(section.content, opts);
      for (const text of textChunks) {
        chunks.push(
          makeChunk(doc, sectionPath, section.title, text, chunks.length)
        );
      }
    }
  }

  return chunks;
}

/**
 * Merge sections that are too small (below minTokens) into their next sibling.
 */
function mergeSections(
  sections: ParsedSection[],
  minTokens: number
): ParsedSection[] {
  const result: ParsedSection[] = [];

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    const tokens = estimateTokens(section.content);

    if (tokens < minTokens && result.length > 0) {
      // Merge into previous section
      const prev = result[result.length - 1];
      prev.content = `${prev.content}\n\n${section.title}\n${section.content}`;
    } else if (tokens < minTokens && i + 1 < sections.length) {
      // Merge into next section
      const next = sections[i + 1];
      sections[i + 1] = {
        ...next,
        content: `${section.title}\n${section.content}\n\n${next.content}`,
      };
    } else {
      result.push({ ...section });
    }
  }

  return result;
}

/**
 * Split text that exceeds maxTokens into overlapping chunks.
 * Splits on paragraph boundaries when possible, falling back to sentences.
 */
function splitText(
  text: string,
  opts: Required<ChunkerOptions>
): string[] {
  const totalTokens = estimateTokens(text);
  if (totalTokens <= opts.maxTokens) return [text];

  const chunks: string[] = [];

  // Split into paragraphs first
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim());

  let currentChunk: string[] = [];
  let currentTokens = 0;

  for (const para of paragraphs) {
    const paraTokens = estimateTokens(para);

    if (currentTokens + paraTokens > opts.maxTokens && currentChunk.length > 0) {
      chunks.push(currentChunk.join("\n\n"));

      // Overlap: keep trailing paragraphs that fit in overlap budget
      const overlapChunk: string[] = [];
      let overlapTokens = 0;
      for (let i = currentChunk.length - 1; i >= 0; i--) {
        const pTokens = estimateTokens(currentChunk[i]);
        if (overlapTokens + pTokens > opts.overlapTokens) break;
        overlapChunk.unshift(currentChunk[i]);
        overlapTokens += pTokens;
      }
      currentChunk = overlapChunk;
      currentTokens = overlapTokens;
    }

    // If a single paragraph exceeds maxTokens, split by sentences
    if (paraTokens > opts.maxTokens) {
      const sentences = para.split(/(?<=[.!?])\s+/);
      for (const sentence of sentences) {
        const sTokens = estimateTokens(sentence);
        if (currentTokens + sTokens > opts.maxTokens && currentChunk.length > 0) {
          chunks.push(currentChunk.join("\n\n"));
          currentChunk = [];
          currentTokens = 0;
        }
        currentChunk.push(sentence);
        currentTokens += sTokens;
      }
    } else {
      currentChunk.push(para);
      currentTokens += paraTokens;
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk.join("\n\n"));
  }

  return chunks;
}

function makeChunk(
  doc: ParsedDocument,
  sectionPath: string,
  sectionTitle: string,
  content: string,
  index: number
): Chunk {
  return {
    id: `${doc.filePath}#chunk-${index}`,
    documentPath: doc.filePath,
    sectionPath,
    sectionTitle,
    content: content.trim(),
    chunkIndex: index,
    tokenEstimate: estimateTokens(content),
    format: doc.format,
    documentTitle: doc.title,
  };
}

/**
 * Rough token estimate: ~4 characters per token for English text.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
