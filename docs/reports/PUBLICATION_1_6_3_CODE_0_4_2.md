# Verified publication: Harness 1.6.3 and Code 0.4.2

Both packages were published on npm `latest` on 2026-11-10. Code pins Harness `1.6.3` exactly. Annotated tags `v1.6.3` and `code-v0.4.2` resolve to [`7ba14a08e4a3fd60f3ea50263cb0bebdd5fc125a`](https://github.com/Zhivex/zhivex-harness/commit/7ba14a08e4a3fd60f3ea50263cb0bebdd5fc125a), integrated through [PR #273](https://github.com/Zhivex/zhivex-harness/pull/273).

| Package | Published at (UTC) | Successful protected workflow |
| --- | --- | --- |
| `@zhivex-ai/harness@1.6.3` | `2026-11-10T18:09:31.928Z` | [Harness publication and certification](https://github.com/Zhivex/zhivex-harness/actions/runs/42865111096) |
| `@zhivex-ai/code@0.4.2` | `2026-11-10T18:25:21.807Z` | [Code publication](https://github.com/Zhivex/zhivex-harness/actions/runs/42873027805) |

## Validation and evidence

The exact main commit passed [CI](https://github.com/Zhivex/zhivex-harness/actions/runs/42863562633), [Code installed journeys](https://github.com/Zhivex/zhivex-harness/actions/runs/42863563023), [Web](https://github.com/Zhivex/zhivex-harness/actions/runs/42863562714) and [CodeQL](https://github.com/Zhivex/zhivex-harness/actions/runs/42863562728).

The protected Harness workflow passed exact-artifact installation, mandatory OCI, all six live-provider gates, approval continuity after compaction, reviewer orchestration, mixed-provider routing, model-directed execution and multi-process continuity. Meta, Qwen, OpenAI, Anthropic, Gemini and Vertex each passed the continuity scenario on the first attempt. The representative matrix passed **42/42** cases: Meta 14/14, Qwen 14/14 and OpenAI 14/14, with no failures or omissions.

Harness registry verification completed before Code was tagged and dispatched. Code then passed real registry resolution of Harness 1.6.3 without candidate overrides, retained-artifact terminal and Web journeys, and the four-package-manager acceptance matrix. Both protected publication jobs and independent local verification confirmed exact registry tarball bytes, `latest`, and SLSA provenance bound to the annotated tags and release source.

The [machine-readable publication evidence](evidence/publication-1.6.3-code-0.4.2-2026-11-10.json) records publication times, integrity strings, workflow links and retained artifact names. The workflow artifacts include the release tarballs, checksum files, installed acceptance, live diagnostics and representative evidence. GitHub artifacts have the workflows' retention limits; their run URLs and the recorded hashes identify the original release.

## Published artifact integrity

These are the protected release artifacts, distinct from the local preparation tarballs in the [historical preparation report](https://github.com/Zhivex/zhivex-harness/blob/a87499d4cd78ae5edcf18c22f2e97f9828e8099f/docs/reports/RELEASE_1_6_3_CODE_0_4_2.md).

```text
sha512-GPqUqeBb4oylmTSzJG4qPsSLqiUoSLFlH1xHm2BIgVQHZDUjtcBZ2UI68+NQptJ6hp78m5P4Lf3+3KpKrXZTbA==  @zhivex-ai/harness@1.6.3
sha512-5/O05HuE4gdsl9FcJ61+0nSUOR1PNu2rKWRLHUNxI3YPD5NS9+ChOR0FQw0Xe3n7cRKEH6Aa7XuBfcbZ6H9kXw==  @zhivex-ai/code@0.4.2
```

npm `next` remains Harness `1.4.0-rc.8` and Code `0.3.0-rc.8`. Private Desktop remains alpha. Public API, schema, model defaults and provider stability tiers are unchanged; release-bound live evidence does not grant representative parity to provisional providers. This record certifies only the tagged artifacts, not later source edits.
