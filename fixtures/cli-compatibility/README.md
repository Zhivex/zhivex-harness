# Historical CLI compatibility inventory

`inventory.json` is the unchanged stage-zero parser and terminal-command inventory
previously stored at `docs/reports/unification/stage-0/cli-inventory.json`.
Its source revision and hashes identify the historical observations, not current
source contents. It contains no credentials or machine-specific paths.

`bun run cli:parity` uses this fixture to check the canonical command surface and
writes its generated report to ignored `results/unification/parity.json`.
Keep this input versioned independently of private UX and migration reports.
