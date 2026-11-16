# Internal unification and UX archive

On November 15, 2026, internal unification reports, historical plans, the UI prototype,
captures and migration inventory tools were removed from the publishable tree.
The active products are core, CLI and Electron.

The complete originals (503 files; 22,772,080 bytes) are preserved on a
[private Notion page](https://app.notion.com/p/41a777b104f681779666e4f1e75e0409)
as seven ZIP files and a per-file SHA-256 manifest. Access requires Notion permission;
the archive is not a build or test dependency. An ignored local copy remains under
`.local-docs/branch-preparation-2026-11-15/`.

## Scope

- Archived `docs/reports/unification`, `docs/reports/ux-electron-2026-11-15`,
  `docs/proposals`, `docs/archive`, and the former Core/CLI/Desktop and Code-to-Assistant
  plans. Original paths cited by historical documents are retained inside the ZIPs.
- Archived stage-zero inventory tools that depended on removed interfaces and paths.
- Kept the exact historical input for `bun run cli:parity` at
  `fixtures/cli-compatibility/inventory.json`. Its hashes identify historical sources.
- Kept technical context reports, failed campaigns and manifest-bound source snapshots
  in `docs/reports/evidence`, without changing their outcomes.
- Normalized the old `HAR_HU_51_SONNET_55_FINAL_PLAN_2026-09-29.json` evidence pointer
  to a repository-relative path; results and recorded artifact hashes are unchanged.
- Historical results do not certify the current checkout. Signing, notarization,
  external accounts and production updates still need independent validation.

## Recovery and integrity

Extract all seven ZIPs into the same empty directory and verify every path, size and
SHA-256 against the attached `manifest.json` before restoring material. Review differences
before overwriting a current checkout. The archive retains unsuccessful attempts as well
as successful runs. The summary in Notion is distinct from the attached originals.

| Archive | SHA-256 |
| --- | --- |
| `historical-tooling-01.zip` | `2600c3fa26a5fc6e06c495f92fb601119a681e992da397ae9f62c1edb86cbb9d` |
| `unification-01.zip` | `28bf80027e98f0971553bc2721e3a8dd7103ece943e99039bdb59cd35b8eb196` |
| `unification-02.zip` | `825aa69fde59adacdc0b6f226f60c233a9fa7bc9d03ef25fe8a61b8e44393b9e` |
| `unification-03.zip` | `7bdcb12ca6964bbf893d190b9984c2744d8b540eb3d7285a495cafdc09df8e7b` |
| `unification-04.zip` | `f351be8200f5dae7f8276311f9b05e4104c64983bdc4e8a4e6cbeef50ef1f8a8` |
| `unification-05.zip` | `d9b1209f1d696bed1337e290f25e712cc07ddb49c96743f81296c4fbb76d826e` |
| `ux-and-planning-01.zip` | `001e17fd903d2671ab5d1ac508a642a568c3ce6fd84497ab9b37877155951988` |
