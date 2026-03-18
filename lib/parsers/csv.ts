import Papa from "papaparse";
import { DocumentParser, ParsedDocument, ParsedSection } from "./types";

/**
 * Parser for .csv files using papaparse.
 * Treats the entire CSV as a single section with header-aware row formatting.
 */

export const csvParser: DocumentParser = {
  extensions: [".csv"],

  async parse(buffer: Buffer, filePath: string): Promise<ParsedDocument> {
    const text = buffer.toString("utf-8");

    const result = Papa.parse(text, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: true,
    });

    const headers = result.meta.fields ?? [];
    const rows = result.data as Record<string, unknown>[];

    const textLines: string[] = [];

    if (headers.length > 0) {
      textLines.push(`Columns: ${headers.join(" | ")}`);
      textLines.push("");
    }

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const pairs = headers
        .map((h) => {
          const val = row[h];
          return val != null && val !== "" ? `${h}: ${val}` : null;
        })
        .filter(Boolean);

      if (pairs.length > 0) {
        textLines.push(`Row ${i + 1}: ${pairs.join(" | ")}`);
      }
    }

    const content = textLines.join("\n");
    const fileName = filePath.split("/").pop() ?? filePath;

    return {
      filePath,
      format: "csv",
      title: fileName.replace(/\.csv$/i, ""),
      rawText: content,
      sections: [
        {
          title: fileName.replace(/\.csv$/i, ""),
          level: 1,
          content,
        },
      ],
      metadata: {
        rowCount: rows.length,
        columnCount: headers.length,
        headers,
        parseErrors: result.errors.length,
      },
    };
  },
};
