import path from "node:path";
import { z } from "zod";
import { buildZipArchive, decodeXmlEntities, escapeXml, readZipEntries } from "./ooxml-zip.js";

export type CellValue = string | number | boolean | null;
export type TabularRow = Record<string, CellValue>;

const MAX_ROWS = 50_000;
const MAX_COLUMNS = 200;

function checkRowLimit(dataRows: number) {
  if (dataRows > MAX_ROWS) throw new Error("Tabular analysis supports at most 50,000 data rows.");
}

export const tabularFilterSchema = z.strictObject({
  column: z.string().min(1).max(200),
  op: z.enum(["eq", "neq", "contains", "gt", "gte", "lt", "lte"]),
  value: z.union([z.string().max(500), z.number(), z.boolean()])
});

export const tabularAggregationSchema = z.strictObject({
  column: z.string().min(1).max(200),
  op: z.enum(["sum", "avg", "min", "max", "count"])
});

export const inspectTabularDataSchema = z.strictObject({
  path: z.string().min(1).max(500),
  sheet: z.string().min(1).max(120).optional(),
  delimiter: z.enum([",", ";", "\t", "|"]).optional(),
  filter: tabularFilterSchema.optional(),
  sortBy: z.strictObject({
    column: z.string().min(1).max(200),
    direction: z.enum(["asc", "desc"]).default("asc")
  }).optional(),
  groupBy: z.string().min(1).max(200).optional(),
  aggregations: z.array(tabularAggregationSchema).max(20).optional(),
  limit: z.number().int().min(1).max(50).default(20)
});

export const exportTabularDataSchema = z.strictObject({
  path: z.string().min(1).max(500).refine(
    (value) => /\.(?:csv|xlsx)$/i.test(value),
    "path must end with .csv or .xlsx"
  ),
  sheetName: z.string().min(1).max(31).default("Data"),
  columns: z.array(z.string().min(1).max(200)).min(1).max(100),
  rows: z.array(z.array(z.union([z.string().max(4000), z.number(), z.boolean(), z.null()])).max(100)).max(20_000),
  expectedDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable().default(null)
});

function parseCellScalar(raw: string): CellValue {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^(?:true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === "true";
  if (/^-?(?:\d+|\d*\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) {
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return trimmed;
}

function columnNames(header: readonly (CellValue | undefined)[], width: number): string[] {
  const used = new Set<string>();
  return Array.from({ length: width }, (_, index) => {
    const name = String(header[index] ?? "").trim() || `column_${index + 1}`;
    if (used.has(name)) throw new Error(`Duplicate column header "${name}" at column ${index + 1}.`);
    used.add(name);
    return name;
  });
}

export function parseDelimitedText(text: string, delimiter?: string): { columns: string[]; rows: TabularRow[] } {
  const normalized = text.replace(/^\uFEFF/, "");
  const firstLine = normalized.split(/\r?\n/, 1)[0] ?? "";
  const sep = delimiter ?? (firstLine.includes("\t") ? "\t" : (firstLine.split(";").length > firstLine.split(",").length ? ";" : ","));

  const matrix: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (normalized[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === sep) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && normalized[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((cell) => cell.trim() !== "")) matrix.push(row);
      row = [];
      checkRowLimit(matrix.length - 1);
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some((cell) => cell.trim() !== "")) matrix.push(row);
    checkRowLimit(matrix.length - 1);
  }
  if (!matrix.length) return { columns: [], rows: [] };

  const headerRow = matrix[0]!.slice(0, MAX_COLUMNS);
  const columns = columnNames(headerRow, headerRow.length);
  const rows: TabularRow[] = [];
  for (let r = 1; r < matrix.length; r++) {
    const source = matrix[r]!;
    const record: TabularRow = {};
    for (let c = 0; c < columns.length; c++) {
      record[columns[c]!] = parseCellScalar(source[c] ?? "");
    }
    rows.push(record);
  }
  return { columns, rows };
}

function columnLettersToIndex(letters: string): number {
  let result = 0;
  for (let i = 0; i < letters.length; i++) {
    result = result * 26 + (letters.charCodeAt(i) - 64);
  }
  return result - 1;
}

function indexToColumnLetters(index: number): string {
  let n = index + 1;
  let letters = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

export function parseXlsxBuffer(buffer: Buffer, requestedSheet?: string): {
  sheets: string[];
  activeSheet: string;
  columns: string[];
  rows: TabularRow[];
} {
  const entries = readZipEntries(buffer);
  const workbookXml = entries.get("xl/workbook.xml")?.toString("utf8");
  const relsXml = entries.get("xl/_rels/workbook.xml.rels")?.toString("utf8");
  if (!workbookXml) throw new Error("Invalid .xlsx file: missing xl/workbook.xml.");

  const relTargets = new Map<string, string>();
  if (relsXml) {
    for (const match of relsXml.matchAll(/<Relationship\b([^>]*)>/g)) {
      const attrs = match[1]!;
      const id = /\sId\s*=\s*(["'])(.*?)\1/.exec(attrs)?.[2];
      const target = /\sTarget\s*=\s*(["'])(.*?)\1/.exec(attrs)?.[2];
      if (id && target) relTargets.set(decodeXmlEntities(id), decodeXmlEntities(target).replace(/^\//, ""));
    }
  }

  const sheetEntries: { name: string; target: string }[] = [];
  for (const match of workbookXml.matchAll(/<sheet\b([^>]+)\/?>/g)) {
    const attrs = match[1]!;
    const nameMatch = /\bname="([^"]+)"/.exec(attrs);
    const relMatch = /\br:id="([^"]+)"/.exec(attrs);
    if (!nameMatch) continue;
    const name = decodeXmlEntities(nameMatch[1]!);
    const relTarget = relMatch ? relTargets.get(relMatch[1]!) : undefined;
    if (relMatch && !relTarget) throw new Error(`Missing worksheet relationship for "${name}".`);
    const target = relTarget
      ? (relTarget.startsWith("xl/") ? relTarget : `xl/${relTarget}`)
      : `xl/worksheets/sheet${sheetEntries.length + 1}.xml`;
    sheetEntries.push({ name, target });
  }
  if (!sheetEntries.length) throw new Error("No worksheets found in .xlsx file.");

  const selected = requestedSheet
    ? sheetEntries.find((s) => s.name === requestedSheet)
    : sheetEntries[0]!;
  if (!selected) {
    throw new Error(`Worksheet "${requestedSheet}" not found. Available sheets: ${sheetEntries.map((s) => s.name).join(", ")}.`);
  }

  const sharedStrings: string[] = [];
  const sharedXml = entries.get("xl/sharedStrings.xml")?.toString("utf8");
  if (sharedXml) {
    for (const si of sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
      let text = "";
      for (const t of si[1]!.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) {
        text += decodeXmlEntities(t[1]!);
      }
      sharedStrings.push(text);
    }
  }

  const sheetXml = entries.get(selected.target)?.toString("utf8");
  if (!sheetXml) throw new Error(`Worksheet data missing at ${selected.target}.`);

  const matrix: CellValue[][] = [];
  let maxCol = 0;

  for (const rowMatch of sheetXml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    if (!rowMatch[1]) continue;
    const cells: CellValue[] = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1]!;
      const body = cellMatch[2] ?? "";
      const refMatch = /\br="([A-Z]+)\d+"/.exec(attrs);
      const colIndex = refMatch ? columnLettersToIndex(refMatch[1]!) : cells.length;
      if (colIndex >= MAX_COLUMNS) continue;
      const typeMatch = /\bt="([^"]+)"/.exec(attrs);
      const cellType = typeMatch?.[1] ?? "";

      let value: CellValue = null;
      if (cellType === "inlineStr") {
        let text = "";
        for (const t of body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) text += decodeXmlEntities(t[1]!);
        value = text || null;
      } else {
        const vMatch = /<v>([\s\S]*?)<\/v>/.exec(body);
        if (vMatch) {
          const raw = decodeXmlEntities(vMatch[1]!);
          if (cellType === "s") {
            value = sharedStrings[Number.parseInt(raw, 10)] ?? null;
          } else if (cellType === "b") {
            value = raw === "1" || raw.toLowerCase() === "true";
          } else if (cellType === "str" || cellType === "e") {
            value = raw;
          } else {
            const num = Number(raw);
            value = Number.isFinite(num) ? num : raw;
          }
        }
      }
      cells[colIndex] = value;
      if (colIndex + 1 > maxCol) maxCol = colIndex + 1;
    }
    if (cells.some((value) => value !== undefined && value !== null && value !== "")) {
      matrix.push(cells);
    }
    checkRowLimit(matrix.length - 1);
  }

  if (!matrix.length) {
    return { sheets: sheetEntries.map((s) => s.name), activeSheet: selected.name, columns: [], rows: [] };
  }

  const columns = columnNames(matrix[0]!, maxCol);

  const rows: TabularRow[] = [];
  for (let r = 1; r < matrix.length; r++) {
    const record: TabularRow = {};
    for (let c = 0; c < columns.length; c++) {
      record[columns[c]!] = matrix[r]![c] ?? null;
    }
    rows.push(record);
  }
  return { sheets: sheetEntries.map((s) => s.name), activeSheet: selected.name, columns, rows };
}

export function parseJsonTabular(text: string): { columns: string[]; rows: TabularRow[] } {
  const parsed: unknown = JSON.parse(text);
  const obj = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  const rawList = Array.isArray(parsed)
    ? parsed
    : obj && Array.isArray(obj.rows)
      ? obj.rows
      : obj && Array.isArray(obj.data)
        ? obj.data
        : obj && Array.isArray(obj.records)
          ? obj.records
          : obj && Array.isArray(obj.items)
            ? obj.items
            : null;
  if (!rawList) throw new Error("JSON file must contain an array of objects (or an object with a rows/data/records/items array).");

  const columnSet = new Set<string>();
  checkRowLimit(rawList.length);
  for (const item of rawList) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      for (const key of Object.keys(item)) {
        if (columnSet.size < MAX_COLUMNS) columnSet.add(key);
      }
    }
  }
  const columns = [...columnSet];
  const rows: TabularRow[] = rawList
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    .map((item) => {
      const record: TabularRow = {};
      for (const col of columns) {
        const val = item[col];
        record[col] = typeof val === "string" || typeof val === "number" || typeof val === "boolean" ? val : (val == null ? null : JSON.stringify(val));
      }
      return record;
    });
  return { columns, rows };
}

function matchesFilter(row: TabularRow, filter: z.infer<typeof tabularFilterSchema>): boolean {
  const cell = row[filter.column];
  if (cell === null || cell === undefined) return filter.op === "neq";
  switch (filter.op) {
    case "eq": return cell === filter.value || String(cell) === String(filter.value);
    case "neq": return cell !== filter.value && String(cell) !== String(filter.value);
    case "contains": return String(cell).toLowerCase().includes(String(filter.value).toLowerCase());
    case "gt": return typeof cell === "number" && typeof filter.value === "number" && cell > filter.value;
    case "gte": return typeof cell === "number" && typeof filter.value === "number" && cell >= filter.value;
    case "lt": return typeof cell === "number" && typeof filter.value === "number" && cell < filter.value;
    case "lte": return typeof cell === "number" && typeof filter.value === "number" && cell <= filter.value;
  }
}

export function analyzeTabularFile(
  filePath: string,
  contents: Buffer,
  options: Omit<z.infer<typeof inspectTabularDataSchema>, "path">
) {
  const ext = path.extname(filePath).toLowerCase();
  let sheets: string[] | undefined;
  let activeSheet: string | undefined;
  let columns: string[];
  let rows: TabularRow[];

  if (ext === ".xlsx") {
    const parsed = parseXlsxBuffer(contents, options.sheet);
    sheets = parsed.sheets;
    activeSheet = parsed.activeSheet;
    columns = parsed.columns;
    rows = parsed.rows;
  } else if (ext === ".json") {
    ({ columns, rows } = parseJsonTabular(contents.toString("utf8")));
  } else if (ext === ".csv" || ext === ".tsv" || ext === ".txt") {
    ({ columns, rows } = parseDelimitedText(contents.toString("utf8"), options.delimiter ?? (ext === ".tsv" ? "\t" : undefined)));
  } else {
    throw new Error(`Unsupported tabular format "${ext || "unknown"}". Supported formats: .csv, .tsv, .json, .xlsx.`);
  }

  const totalRows = rows.length;
  let working = options.filter ? rows.filter((row) => matchesFilter(row, options.filter!)) : rows;

  if (options.sortBy) {
    const { column, direction } = options.sortBy;
    const factor = direction === "desc" ? -1 : 1;
    working = [...working].sort((a, b) => {
      const av = a[column];
      const bv = b[column];
      if (av === bv) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * factor;
      return String(av).localeCompare(String(bv)) * factor;
    });
  }

  const profile = columns.map((column) => {
    let nonNull = 0;
    let numericCount = 0;
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    const distinct = new Set<CellValue>();
    const types = new Set<string>();
    for (const row of working) {
      const val = row[column];
      if (val === null || val === undefined) continue;
      nonNull++;
      distinct.add(val);
      types.add(typeof val);
      if (typeof val === "number") {
        numericCount++;
        sum += val;
        if (val < min) min = val;
        if (val > max) max = val;
      }
    }
    const inferredType = types.size === 0 ? "empty" : types.size === 1 ? [...types][0]! : "mixed";
    return {
      column,
      type: inferredType,
      nonNull,
      distinct: distinct.size,
      ...(numericCount > 0 ? {
        numeric: {
          count: numericCount,
          min,
          max,
          sum: Number(sum.toFixed(6)),
          mean: Number((sum / numericCount).toFixed(6))
        }
      } : {})
    };
  });

  let grouped: Record<string, CellValue>[] | undefined;
  if (options.groupBy) {
    const buckets = new Map<string, TabularRow[]>();
    for (const row of working) {
      const key = row[options.groupBy] == null ? "(empty)" : String(row[options.groupBy]);
      const list = buckets.get(key);
      if (list) list.push(row);
      else buckets.set(key, [row]);
    }
    const aggs = options.aggregations ?? [];
    grouped = [...buckets.entries()].slice(0, 100).map(([groupValue, groupRows]) => {
      const summary: Record<string, CellValue> = { [options.groupBy!]: groupValue, count: groupRows.length };
      for (const agg of aggs) {
        const nums = groupRows.map((r) => r[agg.column]).filter((v): v is number => typeof v === "number");
        const key = `${agg.op}_${agg.column}`;
        if (agg.op === "count") summary[key] = groupRows.filter((r) => r[agg.column] != null).length;
        else if (!nums.length) summary[key] = null;
        else if (agg.op === "sum") summary[key] = Number(nums.reduce((a, b) => a + b, 0).toFixed(6));
        else if (agg.op === "avg") summary[key] = Number((nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(6));
        else if (agg.op === "min") summary[key] = Math.min(...nums);
        else if (agg.op === "max") summary[key] = Math.max(...nums);
      }
      return summary;
    });
  }

  return {
    path: filePath,
    format: ext.slice(1),
    ...(sheets ? { sheets, activeSheet } : {}),
    totalRows,
    matchedRows: working.length,
    columns,
    profile,
    ...(grouped ? { grouped } : {}),
    preview: working.slice(0, options.limit)
  };
}

function escapeCsvField(value: CellValue): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

export function buildTabularExportBytes(input: z.infer<typeof exportTabularDataSchema>): Buffer {
  if (/\.csv$/i.test(input.path)) {
    const lines = [
      input.columns.map(escapeCsvField).join(","),
      ...input.rows.map((row) => input.columns.map((_, idx) => escapeCsvField(row[idx] ?? null)).join(","))
    ];
    return Buffer.from(lines.join("\n") + "\n", "utf8");
  }

  const sheetXmlRows: string[] = [];
  const encodeRow = (rowIndex: number, values: readonly CellValue[]) => {
    const cells = values.map((val, colIndex) => {
      const ref = `${indexToColumnLetters(colIndex)}${rowIndex}`;
      if (val === null || val === undefined) return "";
      if (typeof val === "number" && Number.isFinite(val)) {
        return `<c r="${ref}"><v>${val}</v></c>`;
      }
      if (typeof val === "boolean") {
        return `<c r="${ref}" t="b"><v>${val ? 1 : 0}</v></c>`;
      }
      return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(String(val))}</t></is></c>`;
    }).filter(Boolean).join("");
    return `<row r="${rowIndex}">${cells}</row>`;
  };

  sheetXmlRows.push(encodeRow(1, input.columns));
  for (let i = 0; i < input.rows.length; i++) {
    sheetXmlRows.push(encodeRow(i + 2, input.rows[i]!));
  }

  const safeSheetName = escapeXml(input.sheetName.replace(/[\[\]*?:/\\]/g, "_").slice(0, 31) || "Data");
  return buildZipArchive([
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
    },
    {
      name: "xl/workbook.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${safeSheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`
    },
    {
      name: "xl/worksheets/sheet1.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetXmlRows.join("")}</sheetData></worksheet>`
    }
  ]);
}
