import { z } from "zod";
import { buildZipArchive, escapeXml, type ZipEntryInput } from "./ooxml-zip.js";

const slideMetricSchema = z.strictObject({
  label: z.string().min(1).max(80),
  value: z.string().min(1).max(60),
  note: z.string().max(120).optional()
});

const slideTableSchema = z.strictObject({
  headers: z.array(z.string().min(1).max(120)).min(1).max(8),
  rows: z.array(z.array(z.string().max(300)).max(8)).max(15)
});

export const presentationSlideSchema = z.strictObject({
  title: z.string().min(1).max(160),
  subtitle: z.string().max(240).optional(),
  bullets: z.array(z.string().min(1).max(400)).max(10).optional(),
  metrics: z.array(slideMetricSchema).max(4).optional(),
  table: slideTableSchema.optional(),
  notes: z.string().max(2000).optional()
});

export const generatePresentationSchema = z.strictObject({
  path: z.string().min(1).max(500).refine(
    (value) => /\.(?:pptx|html)$/i.test(value),
    "path must end with .pptx or .html"
  ),
  title: z.string().min(1).max(160),
  subtitle: z.string().max(240).optional(),
  author: z.string().max(120).optional(),
  theme: z.enum(["executive", "light", "dark"]).default("executive"),
  slides: z.array(presentationSlideSchema).min(1).max(40),
  expectedDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable().default(null)
});

export type GeneratePresentationInput = z.infer<typeof generatePresentationSchema>;

const THEMES = {
  executive: { bg: "F8F9FA", accent: "1D4ED8", title: "0F172A", body: "334155", cardBg: "FFFFFF", border: "CBD5E1" },
  light: { bg: "FFFFFF", accent: "0F766E", title: "111827", body: "374151", cardBg: "F3F4F6", border: "D1D5DB" },
  dark: { bg: "0F172A", accent: "38BDF8", title: "F8FAFC", body: "CBD5E1", cardBg: "1E293B", border: "334155" }
} as const;

function pptTextBox(id: number, name: string, x: number, y: number, cx: number, cy: number, paragraphs: string[], fillHex?: string): string {
  const fillXml = fillHex ? `<a:solidFill><a:srgbClr val="${fillHex}"/></a:solidFill>` : "<a:noFill/>";
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${escapeXml(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${fillXml}</p:spPr><p:txBody><a:bodyPr wrap="square" lIns="91440" tIns="45720" rIns="91440" bIns="45720"/><a:lstStyle/>${paragraphs.join("")}</p:txBody></p:sp>`;
}

function pptParagraph(text: string, sizePt: number, colorHex: string, bold = false, bullet = false): string {
  const bulletXml = bullet ? `<a:buChar char="•"/>` : "<a:buNone/>";
  const pPr = `<a:pPr${bullet ? ' marL="228600" indent="-228600"' : ""}>${bulletXml}</a:pPr>`;
  return `<a:p>${pPr}<a:r><a:rPr lang="en-US" sz="${sizePt * 100}" b="${bold ? 1 : 0}"><a:solidFill><a:srgbClr val="${colorHex}"/></a:solidFill><a:latin typeface="Calibri"/></a:rPr><a:t>${escapeXml(text)}</a:t></a:r></a:p>`;
}

function buildSlideXml(slide: GeneratePresentationInput["slides"][number], slideNumber: number, totalSlides: number, palette: typeof THEMES[keyof typeof THEMES]): string {
  const shapes: string[] = [];
  let shapeId = 2;

  // Accent bar at top
  shapes.push(pptTextBox(shapeId++, "Accent", 0, 0, 12192000, 91440, [pptParagraph("", 6, palette.accent)], palette.accent));

  // Title & subtitle
  const headerParagraphs = [pptParagraph(slide.title, 28, palette.title, true)];
  if (slide.subtitle) headerParagraphs.push(pptParagraph(slide.subtitle, 15, palette.accent));
  shapes.push(pptTextBox(shapeId++, "Title", 548640, 274320, 11094720, 1097280, headerParagraphs));

  let currentY = 1463040;

  // KPI Metrics row
  if (slide.metrics?.length) {
    const count = slide.metrics.length;
    const gap = 182880;
    const cardW = Math.floor((11094720 - gap * (count - 1)) / count);
    const cardH = 1280160;
    slide.metrics.forEach((metric, index) => {
      const x = 548640 + index * (cardW + gap);
      const paras = [
        pptParagraph(metric.label.toUpperCase(), 11, palette.body, true),
        pptParagraph(metric.value, 24, palette.accent, true),
        ...(metric.note ? [pptParagraph(metric.note, 11, palette.body)] : [])
      ];
      shapes.push(pptTextBox(shapeId++, `Metric ${index + 1}`, x, currentY, cardW, cardH, paras, palette.cardBg));
    });
    currentY += cardH + 228600;
  }

  // Bullets
  if (slide.bullets?.length) {
    const bulletHeight = slide.table ? 1828800 : 4114800;
    const paras = slide.bullets.map((line) => pptParagraph(line, 16, palette.body, false, true));
    shapes.push(pptTextBox(shapeId++, "Body", 548640, currentY, 11094720, bulletHeight, paras));
    currentY += bulletHeight + 182880;
  }

  // Table (rendered cleanly as formatted rows)
  if (slide.table) {
    const colCount = slide.table.headers.length;
    const colW = Math.floor(11094720 / colCount);
    const gridCols = Array.from({ length: colCount }, () => `<a:gridCol w="${colW}"/>`).join("");
    const cellXml = (text: string, isHeader: boolean) =>
      `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${pptParagraph(text, isHeader ? 12 : 11, isHeader ? "FFFFFF" : palette.body, isHeader)}</a:txBody><a:tcPr><a:solidFill><a:srgbClr val="${isHeader ? palette.accent : palette.cardBg}"/></a:solidFill></a:tcPr></a:tc>`;
    const headerRow = `<a:tr h="365760">${slide.table.headers.map((h) => cellXml(h, true)).join("")}</a:tr>`;
    const dataRows = slide.table.rows.map((r) => `<a:tr h="320040">${slide.table!.headers.map((_, idx) => cellXml(r[idx] ?? "", false)).join("")}</a:tr>`).join("");
    const tableH = Math.min(3200400, (slide.table.rows.length + 1) * 340000);
    shapes.push(`<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${shapeId++}" name="Table"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="548640" y="${currentY}"/><a:ext cx="11094720" cy="${tableH}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid>${gridCols}</a:tblGrid>${headerRow}${dataRows}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`);
  }

  // Footer
  shapes.push(pptTextBox(shapeId++, "Footer", 548640, 6400800, 11094720, 320040, [pptParagraph(`Zhivex · Slide ${slideNumber} / ${totalSlides}`, 10, palette.body)]));

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="${palette.bg}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes.join("")}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

export function buildPptxBuffer(spec: GeneratePresentationInput): Buffer {
  const palette = THEMES[spec.theme];
  const entries: ZipEntryInput[] = [];
  const slideContentTypes: string[] = [];
  const presentationRels: string[] = [
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>`
  ];
  const sldIdList: string[] = [];

  spec.slides.forEach((slide, idx) => {
    const num = idx + 1;
    const relId = `rId${num + 1}`;
    slideContentTypes.push(`<Override PartName="/ppt/slides/slide${num}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`);
    presentationRels.push(`<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${num}.xml"/>`);
    sldIdList.push(`<p:sldId id="${256 + idx}" r:id="${relId}"/>`);
    entries.push({
      name: `ppt/slides/slide${num}.xml`,
      data: buildSlideXml(slide, num, spec.slides.length, palette)
    });
    entries.push({
      name: `ppt/slides/_rels/slide${num}.xml.rels`,
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`
    });
  });

  entries.push(
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${slideContentTypes.join("")}</Types>`
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`
    },
    {
      name: "ppt/presentation.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${sldIdList.join("")}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`
    },
    {
      name: "ppt/_rels/presentation.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${presentationRels.join("")}</Relationships>`
    },
    {
      name: "ppt/slideMasters/slideMaster1.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`
    },
    {
      name: "ppt/slideMasters/_rels/slideMaster1.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`
    },
    {
      name: "ppt/slideLayouts/slideLayout1.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld></p:sldLayout>`
    },
    {
      name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`
    },
    {
      name: "ppt/theme/theme1.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Zhivex"><a:themeElements><a:clrScheme name="Zhivex"><a:dk1><a:srgbClr val="0F172A"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="334155"/></a:dk2><a:lt2><a:srgbClr val="F8FAFC"/></a:lt2><a:accent1><a:srgbClr val="${palette.accent}"/></a:accent1><a:accent2><a:srgbClr val="0F766E"/></a:accent2><a:accent3><a:srgbClr val="7C3AED"/></a:accent3><a:accent4><a:srgbClr val="D97706"/></a:accent4><a:accent5><a:srgbClr val="DC2626"/></a:accent5><a:accent6><a:srgbClr val="0284C7"/></a:accent6><a:hlink><a:srgbClr val="2563EB"/></a:hlink><a:folHlink><a:srgbClr val="6D28D9"/></a:folHlink></a:clrScheme><a:fontScheme name="Zhivex"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Zhivex"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`
    }
  );

  return buildZipArchive(entries);
}

export function buildHtmlDeck(spec: GeneratePresentationInput): string {
  const palette = THEMES[spec.theme];
  const slidesHtml = spec.slides.map((slide, idx) => {
    const metrics = slide.metrics?.length
      ? `<div class="metrics">${slide.metrics.map((m) => `<div class="metric"><span class="label">${escapeXml(m.label)}</span><strong>${escapeXml(m.value)}</strong>${m.note ? `<small>${escapeXml(m.note)}</small>` : ""}</div>`).join("")}</div>`
      : "";
    const bullets = slide.bullets?.length
      ? `<ul>${slide.bullets.map((b) => `<li>${escapeXml(b)}</li>`).join("")}</ul>`
      : "";
    const table = slide.table
      ? `<table><thead><tr>${slide.table.headers.map((h) => `<th>${escapeXml(h)}</th>`).join("")}</tr></thead><tbody>${slide.table.rows.map((r) => `<tr>${slide.table!.headers.map((_, i) => `<td>${escapeXml(r[i] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table>`
      : "";
    return `<section class="slide" data-slide="${idx + 1}"><header><h1>${escapeXml(slide.title)}</h1>${slide.subtitle ? `<p class="subtitle">${escapeXml(slide.subtitle)}</p>` : ""}</header>${metrics}${bullets}${table}<footer><span>${escapeXml(spec.title)}</span><span>${idx + 1} / ${spec.slides.length}</span></footer></section>`;
  }).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeXml(spec.title)}</title>
<style>
  :root { --bg:#${palette.bg}; --accent:#${palette.accent}; --title:#${palette.title}; --body:#${palette.body}; --card:#${palette.cardBg}; --border:#${palette.border}; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--body); }
  .slide { min-height: 100vh; padding: 56px 72px; display: flex; flex-direction: column; gap: 24px; border-top: 6px solid var(--accent); page-break-after: always; }
  h1 { margin: 0; font-size: 2.2rem; color: var(--title); }
  .subtitle { margin: 6px 0 0; color: var(--accent); font-size: 1.1rem; font-weight: 500; }
  .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; }
  .metric { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 18px; display: flex; flex-direction: column; gap: 6px; }
  .metric .label { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.8; }
  .metric strong { font-size: 1.8rem; color: var(--accent); }
  ul { margin: 0; padding-left: 24px; font-size: 1.15rem; line-height: 1.7; }
  table { width: 100%; border-collapse: collapse; background: var(--card); border: 1px solid var(--border); }
  th { background: var(--accent); color: #fff; text-align: left; padding: 10px 14px; font-size: 0.9rem; }
  td { padding: 9px 14px; border-top: 1px solid var(--border); font-size: 0.92rem; }
  footer { margin-top: auto; display: flex; justify-content: space-between; font-size: 0.82rem; opacity: 0.7; }
  @media print { .slide { min-height: 0; height: 100vh; } }
</style>
</head>
<body>
${slidesHtml}
</body>
</html>
`;
}

export function buildPresentationBytes(spec: GeneratePresentationInput): Buffer {
  return /\.pptx$/i.test(spec.path) ? buildPptxBuffer(spec) : Buffer.from(buildHtmlDeck(spec), "utf8");
}
