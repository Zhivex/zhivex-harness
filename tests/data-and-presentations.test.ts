import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { Workspace } from "../packages/core/src/workspace/workspace.js";
import { createWorkspaceTools } from "../packages/core/src/tools/workspace.js";
import { buildZipArchive, readZipEntries } from "../packages/core/src/tools/ooxml-zip.js";

async function withTempWorkspace<T>(fn: (workspace: Workspace, root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "zhivex-data-decks-"));
  try {
    const workspace = await Workspace.open(root);
    return await fn(workspace, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("Step 2: local tabular data analysis and presentations", () => {
  test("tool approval metadata matches read-only vs mutation governance", async () => {
    await withTempWorkspace(async (workspace) => {
      const tools = createWorkspaceTools(workspace, []);
      expect(tools.inspect_tabular_data.requiresApproval).toBeFalsy();
      expect(tools.export_tabular_data.requiresApproval).toBe(true);
      expect(tools.export_tabular_data.approvalMode).toBe("interrupt");
      expect(tools.generate_presentation.requiresApproval).toBe(true);
      expect(tools.generate_presentation.approvalMode).toBe("interrupt");
    });
  });

  test("analyzes CSV, TSV, and JSON files with filtering, sorting, and grouped aggregations", async () => {
    await withTempWorkspace(async (workspace, root) => {
      await writeFile(
        path.join(root, "sales.csv"),
        [
          "region,rep,revenue,deals,active",
          "EMEA,Alice,12000,4,true",
          "EMEA,Bob,8000,2,true",
          "AMER,Carol,25000,6,true",
          "APAC,Dan,5000,1,false"
        ].join("\n"),
        "utf8"
      );
      await writeFile(
        path.join(root, "metrics.tsv"),
        "quarter\tmargin\nQ1\t0.42\nQ2\t0.48\n",
        "utf8"
      );
      await writeFile(
        path.join(root, "records.json"),
        JSON.stringify({
          records: [
            { channel: "Direct", spend: 1000, leads: 50 },
            { channel: "Partner", spend: 600, leads: 35 }
          ]
        }),
        "utf8"
      );

      const tools = createWorkspaceTools(workspace, []);

      const csvResult = await tools.inspect_tabular_data.execute({
        path: "sales.csv",
        filter: { column: "active", op: "eq", value: true },
        sortBy: { column: "revenue", direction: "desc" },
        groupBy: "region",
        aggregations: [
          { column: "revenue", op: "sum" },
          { column: "deals", op: "avg" }
        ],
        limit: 10
      }) as Record<string, any>;
      expect(csvResult.format).toBe("csv");
      expect(csvResult.totalRows).toBe(4);
      expect(csvResult.matchedRows).toBe(3);
      expect(csvResult.preview[0].rep).toBe("Carol");
      const emeaGroup = csvResult.grouped.find((g: Record<string, unknown>) => g.region === "EMEA");
      expect(emeaGroup).toEqual({
        region: "EMEA",
        count: 2,
        sum_revenue: 20000,
        avg_deals: 3
      });

      const tsvResult = await tools.inspect_tabular_data.execute({
        path: "metrics.tsv",
        limit: 10
      }) as Record<string, any>;
      expect(tsvResult.format).toBe("tsv");
      expect(tsvResult.totalRows).toBe(2);
      expect(tsvResult.profile.find((p: { column: string }) => p.column === "margin").numeric.mean).toBe(0.45);

      const jsonResult = await tools.inspect_tabular_data.execute({
        path: "records.json",
        limit: 10
      }) as Record<string, any>;
      expect(jsonResult.format).toBe("json");
      expect(jsonResult.totalRows).toBe(2);
      expect(jsonResult.columns).toEqual(["channel", "spend", "leads"]);
    });
  });

  test("round-trips XLSX export and inspection and enforces expectedDigest on overwrite", async () => {
    await withTempWorkspace(async (workspace) => {
      const tools = createWorkspaceTools(workspace, []);

      const created = await tools.export_tabular_data.execute({
        path: "reports/q3-summary.xlsx",
        sheetName: "Q3Summary",
        columns: ["Region", "Revenue", "Growth", "Active"],
        rows: [
          ["EMEA", 42000, 0.18, true],
          ["AMER", 68000, 0.24, true],
          ["APAC", 19500, 0.11, false]
        ],
        expectedDigest: null
      }) as Record<string, any>;

      expect(created.format).toBe("xlsx");
      expect(created.rowCount).toBe(3);
      expect(created.digest).toMatch(/^sha256:[a-f0-9]{64}$/);

      const inspected = await tools.inspect_tabular_data.execute({
        path: "reports/q3-summary.xlsx",
        sortBy: { column: "Revenue", direction: "desc" },
        limit: 10
      }) as Record<string, any>;

      expect(inspected.format).toBe("xlsx");
      expect(inspected.sheets).toEqual(["Q3Summary"]);
      expect(inspected.activeSheet).toBe("Q3Summary");
      expect(inspected.totalRows).toBe(3);
      expect(inspected.preview[0]).toEqual({
        Region: "AMER",
        Revenue: 68000,
        Growth: 0.24,
        Active: true
      });

      // Overwriting with expectedDigest=null must fail closed
      await expect(tools.export_tabular_data.execute({
        path: "reports/q3-summary.xlsx",
        sheetName: "Q3Summary",
        columns: ["Region", "Revenue"],
        rows: [["EMEA", 50000]],
        expectedDigest: null
      })).rejects.toThrow(/already exists/i);

      // Overwriting with exact digest succeeds
      const updated = await tools.export_tabular_data.execute({
        path: "reports/q3-summary.xlsx",
        sheetName: "Q3Summary",
        columns: ["Region", "Revenue"],
        rows: [["EMEA", 50000]],
        expectedDigest: created.digest
      }) as Record<string, any>;
      expect(updated.digest).not.toBe(created.digest);
    });
  });

  test("generates valid PPTX and print-ready HTML presentations", async () => {
    await withTempWorkspace(async (workspace, root) => {
      const tools = createWorkspaceTools(workspace, []);

      const pptxCreated = await tools.generate_presentation.execute({
        path: "decks/board-update.pptx",
        title: "Q3 Executive Review",
        subtitle: "Revenue, Pipeline & Roadmap",
        author: "Zhivex Workspace",
        theme: "executive",
        slides: [
          {
            title: "Q3 Highlights",
            subtitle: "Strong growth across all regions",
            metrics: [
              { label: "ARR", value: "$4.2M", note: "+22% YoY" },
              { label: "NRR", value: "118%", note: "Enterprise segment" }
            ],
            bullets: [
              "Closed 14 enterprise accounts",
              "Reduced onboarding time by 35%"
            ]
          },
          {
            title: "Regional Breakdown",
            table: {
              headers: ["Region", "Revenue", "YoY"],
              rows: [
                ["AMER", "$2.4M", "+26%"],
                ["EMEA", "$1.3M", "+19%"],
                ["APAC", "$0.5M", "+14%"]
              ]
            },
            notes: "Highlight EMEA enterprise expansion."
          }
        ],
        expectedDigest: null
      }) as Record<string, any>;

      expect(pptxCreated.format).toBe("pptx");
      expect(pptxCreated.slideCount).toBe(2);

      const pptxBytes = await readFile(path.join(root, "decks/board-update.pptx"));
      const zipEntries = readZipEntries(pptxBytes);
      expect(zipEntries.has("[Content_Types].xml")).toBe(true);
      expect(zipEntries.has("ppt/presentation.xml")).toBe(true);
      expect(zipEntries.has("ppt/slides/slide1.xml")).toBe(true);
      expect(zipEntries.has("ppt/slides/slide2.xml")).toBe(true);
      const slide1Xml = zipEntries.get("ppt/slides/slide1.xml")!.toString("utf8");
      expect(slide1Xml).toContain("Q3 Highlights");
      expect(slide1Xml).toContain("$4.2M");
      const slide2Xml = zipEntries.get("ppt/slides/slide2.xml")!.toString("utf8");
      expect(slide2Xml).toContain("Regional Breakdown");
      expect(slide2Xml).toContain("AMER");

      const htmlCreated = await tools.generate_presentation.execute({
        path: "decks/board-update.html",
        title: "Q3 Executive Review",
        theme: "dark",
        slides: [
          {
            title: "Executive Summary",
            bullets: ["Local-first deck generation", "Zero Docker required"]
          }
        ],
        expectedDigest: null
      }) as Record<string, any>;
      expect(htmlCreated.format).toBe("html");
      const htmlText = await readFile(path.join(root, "decks/board-update.html"), "utf8");
      expect(htmlText).toContain("<!doctype html>");
      expect(htmlText).toContain("Executive Summary");
      expect(htmlText).toContain("Local-first deck generation");
    });
  });

  test("rejects path traversal, sensitive files, and ZIP-bomb entry overflows", async () => {
    await withTempWorkspace(async (workspace, root) => {
      await writeFile(path.join(root, ".env"), "API_KEY=secret\n", "utf8");
      const tools = createWorkspaceTools(workspace, []);

      await expect(tools.inspect_tabular_data.execute({
        path: "../outside.csv",
        limit: 10
      })).rejects.toThrow();

      await expect(tools.inspect_tabular_data.execute({
        path: ".env",
        limit: 10
      })).rejects.toThrow();

      await expect(tools.export_tabular_data.execute({
        path: "../escape.csv",
        sheetName: "Data",
        columns: ["a"],
        rows: [["1"]],
        expectedDigest: null
      })).rejects.toThrow();

      // ZIP-bomb entry count bound
      const archive = buildZipArchive([
        { name: "a.txt", data: "1" },
        { name: "b.txt", data: "2" },
        { name: "c.txt", data: "3" }
      ]);
      assert.throws(() => readZipEntries(archive, { maxEntries: 2 }), /entry limit/i);
    });
  });
});
