# Offline task measurement

Read [the preregistered protocol](PROTOCOL.md) before running. This contributor
instrument measures synthetic fixture correctness and local operation latency.
It does not measure human review, production inference cost or productivity.

## Reproduce

Requirements: Bun 1.4+, supported Node 22.13+ with SQLite, npm, Git and tar;
a clean evaluator checkout; the exact two accepted candidate archives and
independent holdout identified by the manifest. npm installation may fetch pinned
dependencies. Task execution makes no paid model calls. Use a trusted local
machine: fixtures execute as native code, not inside a security sandbox.

```sh
bun test tests/task-measurement.test.js
bun scripts/task-measurement-installed.mjs \
  /absolute/harness-docs-fixed.tgz /absolute/code-final.tgz \
  /absolute/node /absolute/holdout.json /absolute/new-output-directory
```

The output directory must not exist. The runner freezes source/input/environment
and registers positive and negative cases before dispatch. It installs archives
without lifecycle scripts into a temporary consumer, verifies every product file,
uses only installed public exports, and checks binding again before cleanup.
The product source SHA and evaluator source SHA are separate identities.
`frozen-manifest.json` precedes holdout content access and measured attempts;
`installed-before.json` includes the resolved lock digest and product inventory.
`attempts.json` and `negatives.json` retain all attempts, including failures.
Each completed task includes raw baseline and treatment packets with shared
artifact/run/contract identity. `report.json` includes grouped local percentiles,
accounting, denominators, pending human criteria and cleanup status.

A failed worker is a failed attempt. `PROCESS_TIMEOUT` remains a timeout.
`instrument_error` never counts as a successful negative rejection. A missing
positive base blocks negative credit for that fixture. Source/installed-byte
changes fail binding. Preserve the output; any repair needs a new committed
instrument and new directory. Do not silently retry, discard failures, or change
the frozen holdout after viewing outcomes. The ordinary JS tests run under Bun;
the installed consumer uses the supplied supported Node executable.

The six evidence mutations per fixture test the evaluator's fail-closed boundary;
they do not claim that each synthetic record was produced by the real host.
The four wrong modules are independently authored and checked against visible
and held-out vectors. Neither kind substitutes for real human semantic review.

## Remaining acceptance

The [empty observation worksheet](human-observations.csv) is for a separately
approved human study. Human minutes/quality, live-provider latency and complete
cost per human-accepted task remain unmeasured. No multiagent baseline, team pilot,
release or go decision follows from this instrument. HAR-HU-74 remains in review
until its human/live requirements have valid evidence and the parent accepts it.
