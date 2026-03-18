import * as XLSX from "xlsx";
import { DocumentParser, ParsedDocument, ParsedSection } from "./types";

/**
 * Parser for .xlsx and .xls files using SheetJS.
 * Each sheet becomes a section. Rows are converted to text.
 */

export const xlsxParser: DocumentParser = {
  extensions: [".xlsx", ".xls"],

  async parse(buffer: Buffer, filePath: string): Promise<ParsedDocument> {
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const sections: ParsedSection[] = [];
    const allText: string[] = [];

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet) continue;

      // Convert to array of arrays for structured processing
      const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        defval: "",
      });

      if (rows.length === 0) continue;

      // First row is typically headers
      const headerRow = rows[0] as string[];
      const headers = headerRow.map((h) => String(h).trim()).filter(Boolean);

      // Convert remaining rows to readable text
      const textLines: string[] = [];

      if (headers.length > 0) {
        textLines.push(`Columns: ${headers.join(" | ")}`);
        textLines.push("");
      }

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i] as string[];
        const cells = row.map((c) => String(c).trim());

        // Skip entirely empty rows
        if (cells.every((c) => c === "")) continue;

        if (headers.length > 0) {
          // Format as key-value pairs for readability
          const pairs = headers
            .map((h, j) => {
              const val = cells[j] ?? "";
              return val ? `${h}: ${val}` : null;
            })
            .filter(Boolean);
          textLines.push(`Row ${i}: ${pairs.join(" | ")}`);
        } else {
          textLines.push(cells.filter(Boolean).join(" | "));
        }
      }

      const content = textLines.join("\n");
      sections.push({
        title: sheetName,
        level: 1,
        content,
      });
      allText.push(`## ${sheetName}\n${content}`);
    }

    const fileName = filePath.split("/").pop() ?? filePath;

    return {
      filePath,
      format: "xlsx",
      title: fileName.replace(/\.xlsx?$/i, ""),
      rawText: allText.join("\n\n"),
      sections,
      metadata: {
        sheetCount: workbook.SheetNames.length,
        sheetNames: workbook.SheetNames,
      },
    };
  },
};
