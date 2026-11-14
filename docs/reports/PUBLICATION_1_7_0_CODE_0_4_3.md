# Verified publication: Harness 1.7.0 and Code 0.4.3

Both packages were published on npm `latest` on 2026-11-14. Code pins Harness `1.7.0` exactly. Annotated tags `v1.7.0` and `code-v0.4.3` resolve to [`80618dedc023168d777ca530dab76959ad491687`](https://github.com/Zhivex/zhivex-harness/commit/80618dedc023168d777ca530dab76959ad491687), following [PR #277](https://github.com/Zhivex/zhivex-harness/pull/277) and the certification/publication separation in [PR #278](https://github.com/Zhivex/zhivex-harness/pull/278).

| Package | Published at (UTC) | Successful protected workflow |
| --- | --- | --- |
| `@zhivex-ai/harness@1.7.0` | `2026-11-14T18:07:35.009Z` | [Harness publication](https://github.com/Zhivex/zhivex-harness/actions/runs/43619969669) |
| `@zhivex-ai/code@0.4.3` | `2026-11-14T18:22:41.125Z` | [Code publication](https://github.com/Zhivex/zhivex-harness/actions/runs/43625033978) |

## Validation and evidence

The exact source commit passed CI, Code installed journeys, Web, Assistant and CodeQL. Their run URLs are recorded in the [machine-readable publication evidence](evidence/publication-1.7.0-code-0.4.3-2026-11-14.json).

The [prior certification-only run](https://github.com/Zhivex/zhivex-harness/actions/runs/43616223922) completed without publication on attempt 2. Attempt 1 stopped on an Anthropic authentication HTTP 401; the maintainer corrected the protected credential, and the failed job was retried against the retained tarball. No gate was disabled. Its final result was six providers and 42/42 representative cases passed.

The separate authorized Harness publication run repeated all gates: exact-artifact installation, mandatory OCI, six-provider behavior, approval continuity after compaction, reviewer orchestration, mixed-provider routing, model-directed execution and multi-process continuity. Meta, Qwen, OpenAI, Anthropic, Gemini and Vertex passed. The representative matrix passed **42/42** cases: Meta 14/14, Qwen 14/14 and OpenAI 14/14, with no failures or omissions. The publication tarball SHA-512 equals the earlier certification tarball SHA-512.

Harness registry verification completed before Code was tagged and dispatched. Code passed actual registry resolution of Harness 1.7.0 without candidate overrides, retained-artifact terminal and Web journeys, and the four-package-manager acceptance matrix. Both protected publication jobs and independent local verification confirmed exact registry bytes, `latest`, and SLSA provenance bound to the annotated tags, workflow paths and source commit. Harness metadata propagation took several minutes; publication was not repeated.

Protected workflow artifacts retain tarballs, checksums, installed acceptance and sanitized live/representative evidence under their configured retention limits. This report and its JSON record preserve identities and hashes, not secrets or raw provider output.

## Published artifact integrity

```text
sha512-eDAe0mP3Rg1qkayIubF8P6znoXF0qm4hX8WZTAu4eNOB7lSeTYDkxhn16hGZY11iw7Qfvb12Y/bIC39bgpmFFA==  @zhivex-ai/harness@1.7.0
sha512-4v0Wb+o9DJOROo2prZlnoTbbJ+Dwf9v+eCO8OqH+wvCTtqChnFL2aUHuUnSjR9dwQrGkgw/SQiUnIeIDMQv1iw==  @zhivex-ai/code@0.4.3
```

npm `next` remains Harness `1.4.0-rc.8` and Code `0.3.0-rc.8`. Private Desktop remains alpha and Assistant remains private. Runtime defaults and provider stability tiers are unchanged; six-provider live evidence does not extend the representative matrix beyond Meta, Qwen and OpenAI. This record certifies the tagged artifacts, not later source edits. The [preparation report](https://github.com/Zhivex/zhivex-harness/blob/80618dedc023168d777ca530dab76959ad491687/docs/reports/RELEASE_1_7_0_CODE_0_4_3.md) remains historical.
