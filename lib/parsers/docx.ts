import mammoth from "mammoth";
import { DocumentParser, ParsedDocument, ParsedSection } from "./types";

/**
 * Parser for .docx files using mammoth.
 * Extracts text with heading structure preserved.
 */

interface MammothMessage {
  type: string;
  message: string;
}

export const docxParser: DocumentParser = {
  extensions: [".docx"],

  async parse(buffer: Buffer, filePath: string): Promise<ParsedDocument> {
    // Extract as HTML to preserve heading structure
    const htmlResult = await mammoth.convertToHtml(
      { buffer },
      {
        styleMap: [
          "p[style-name='Heading 1'] => h1:fresh",
          "p[style-name='Heading 2'] => h2:fresh",
          "p[style-name='Heading 3'] => h3:fresh",
          "p[style-name='Heading 4'] => h4:fresh",
        ],
      }
    );

    // Also extract raw text for full-text content
    const textResult = await mammoth.extractRawText({ buffer });

    const sections = extractSectionsFromHtml(htmlResult.value);
    const title = extractTitle(sections, filePath);

    return {
      filePath,
      format: "docx",
      title,
      rawText: textResult.value,
      sections,
      metadata: {
        warnings: htmlResult.messages
          .filter((m: MammothMessage) => m.type === "warning")
          .map((m: MammothMessage) => m.message),
      },
    };
  },
};

/**
 * Parse HTML output from mammoth to extract heading-based sections.
 */
function extractSectionsFromHtml(html: string): ParsedSection[] {
  const sections: ParsedSection[] = [];
  // Match headings h1-h6 and capture everything between them
  const headingRegex =
    /<h([1-6])[^>]*>(.*?)<\/h[1-6]>/gi;

  const headings: Array<{ level: number; title: string; index: number }> = [];
  let match;

  while ((match = headingRegex.exec(html)) !== null) {
    headings.push({
      level: parseInt(match[1]),
      title: stripHtmlTags(match[2]).trim(),
      index: match.index,
    });
  }

  if (headings.length === 0) {
    // No headings found — treat entire document as one section
    const text = stripHtmlTags(html).trim();
    if (text) {
      sections.push({
        title: "(Document)",
        level: 1,
        content: text,
      });
    }
    return sections;
  }

  // Content before first heading
  const preHeadingContent = stripHtmlTags(
    html.substring(0, headings[0].index)
  ).trim();
  if (preHeadingContent) {
    sections.push({
      title: "(Preamble)",
      level: 0,
      content: preHeadingContent,
    });
  }

  // Extract content between each heading
  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    const headingEndMatch = html.indexOf(
      ">",
      heading.index + `<h${heading.level}`.length
    );
    const contentStart =
      html.indexOf(`</h${heading.level}>`, headingEndMatch) +
      `</h${heading.level}>`.length;
    const contentEnd =
      i + 1 < headings.length ? headings[i + 1].index : html.length;

    const content = stripHtmlTags(
      html.substring(contentStart, contentEnd)
    ).trim();

    sections.push({
      title: heading.title,
      level: heading.level,
      content,
    });
  }

  return sections;
}

function stripHtmlTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractTitle(
  sections: ParsedSection[],
  filePath: string
): string {
  // Use first heading as title
  const firstHeading = sections.find((s) => s.level >= 1);
  if (firstHeading) return firstHeading.title;

  // Fall back to filename
  const fileName = filePath.split("/").pop() ?? filePath;
  return fileName.replace(/\.docx$/i, "");
}
