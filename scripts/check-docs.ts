import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const workspace = path.resolve(import.meta.dir, "..");
const manifest = JSON.parse(await readFile(path.join(workspace, "package.json"), "utf8")) as {
  version: string;
};

const markdownFiles = [
  path.join(workspace, "README.md"),
  path.join(workspace, "ROADMAP.md"),
  path.join(workspace, "CHANGELOG.md"),
  ...(await readdir(path.join(workspace, "docs"), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(workspace, "docs", entry.name))
].sort();

const failures: string[] = [];
for (const markdownFile of markdownFiles) {
  const contents = await readFile(markdownFile, "utf8");
  const linkPattern = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const match of contents.matchAll(linkPattern)) {
    const href = match[1]?.replace(/^<|>$/g, "");
    if (!href || href.startsWith("#") || /^(?:https?:|mailto:)/.test(href)) {
      continue;
    }
    const target = decodeURIComponent(href.split("#", 1)[0] ?? "");
    if (!target) {
      continue;
    }
    try {
      await stat(path.resolve(path.dirname(markdownFile), target));
    } catch {
      failures.push(`${path.relative(workspace, markdownFile)}: missing local link target ${target}`);
    }
  }
}

const readme = await readFile(path.join(workspace, "README.md"), "utf8");
const changelog = await readFile(path.join(workspace, "CHANGELOG.md"), "utf8");
if (!readme.includes(`Version \`${manifest.version}\``)) {
  failures.push(`README.md does not identify package version ${manifest.version}.`);
}
if (!changelog.includes(`## ${manifest.version} -`)) {
  failures.push(`CHANGELOG.md has no release entry for ${manifest.version}.`);
}

if (failures.length > 0) {
  throw new Error(`Documentation check failed:\n- ${failures.join("\n- ")}`);
}

process.stdout.write(`Documentation check passed for ${markdownFiles.length} files and version ${manifest.version}.\n`);
