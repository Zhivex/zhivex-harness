# Performance backport assessment

Local comparison on macOS arm64 / Apple M4, Node 26.3 and Bun 1.4.
The baseline was main `b69ab570` with the pending patch-ID recovery and release-gate
changes. The comparison was `feat/release-1.3` at `95aee33`.
These measurements preceded integration; they are not release certification or
end-to-end model latency measurements. OS caches were not flushed.

| Operation | Baseline median ms | Performance branch median ms |
| --- | ---: | ---: |
| Node CLI --version | 181.88 | 39.51 |
| Node CLI --help | 179.96 | 37.87 |
| Node CLI run --help | 182.06 | 179.60 |
| Workspace digest-bound first page | 32.86 | 18.38 |
| Workspace topology first page | 32.97 | 16.17 |
| Workspace digest-bound all pages | 339.09 | 327.77 |
| Workspace topology all pages | 60.45 | 56.73 |
| Workspace three independent searches | 733.79 | 634.56 |
| Workspace searchMany | 325.46 | 311.60 |
| OCI acquire / local snapshot | 454.91 | 295.70 |
| OCI inspect patch | 240.30 | 151.95 |

CLI samples alternate versions: 12 measured invocations after two warmups per
version. Workspace uses `bun run scripts/benchmark-workspace.ts --files 10000
--directories 100 --file-bytes 4096 --page-size 100 --repetitions 5 --warmups 1`
(serial runs per version). OCI uses a filesystem-only fake runtime adapter, 1,000
files of 4,096 bytes across 20 directories, one edited file, independent state
directories, five measured repetitions and one warmup per version. It does not
measure Docker startup or model requests. Search improvements are small/noisy;
these samples do not establish tail-latency guarantees.

Backport the implementation, build configuration and regression tests while
retaining the current package version and representative release matrix. Keep
bounded concurrency, mutation barriers, descriptor-bound reads and aggregate
snapshot byte limits. No provider dependency changes are involved.

The focused Qwen live report predates this integration. The combined artifact is
validated locally and must receive separate exact-artifact live certification
through the existing release gates before publication.
