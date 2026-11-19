# Verified publication: Harness 1.8.0 and Code 0.5.0

Both packages were published on npm `latest` on 2026-11-19. Code pins Harness `1.8.0` exactly. Annotated tags `v1.8.0` and `code-v0.5.0` resolve to [`3c376ec24828cb568426225ef78bf00918345e1f`](https://github.com/Zhivex/zhivex-harness/commit/3c376ec24828cb568426225ef78bf00918345e1f), following [PR #281](https://github.com/Zhivex/zhivex-harness/pull/281), [PR #282](https://github.com/Zhivex/zhivex-harness/pull/282), [PR #283](https://github.com/Zhivex/zhivex-harness/pull/283), and [PR #284](https://github.com/Zhivex/zhivex-harness/pull/284).

| Package | Published at (UTC) | Successful protected workflow |
| --- | --- | --- |
| `@zhivex-ai/harness@1.8.0` | `2026-11-19T22:45:06.485Z` | [Harness publication](https://github.com/Zhivex/zhivex-harness/actions/runs/44594249378) |
| `@zhivex-ai/code@0.5.0` | `2026-11-19T23:08:13.174Z` | [Code publication](https://github.com/Zhivex/zhivex-harness/actions/runs/44633166910) |

## Validation and evidence

The exact source commit passed CI, Code installed journeys, Core Assistant integrations and CodeQL. Their run URLs are recorded in the [machine-readable publication evidence](evidence/publication-1.8.0-code-0.5.0-2026-11-19.json).

The authorized Harness publication workflow passed exact-artifact validation, mandatory OCI, six-provider live certification, and the 42/42 representative repository matrix before publishing. Code `0.5.0` was then published via its protected workflow after passing real registry resolution of Harness `1.8.0` and installed acceptance. Both registry artifacts, `latest` dist-tags and SLSA provenance were verified.

## Published artifact integrity

```text
sha512-WlfNm5oT1VAfeCrE1TDACBOsDytcOSuKkV1bNGXtDm76jaR+n67Jndi5nnLmRtPLigQfXsoshxQN8jcYM8Whxg==  @zhivex-ai/harness@1.8.0
sha512-2gkQ4TbDEMrbU5IywKO3n8TZSZWWAIqPotesFF0UMhFf2AVUynHOa86qH2R7RXp6dU5CsHfiwgZ5HfhTPhrK7A==  @zhivex-ai/code@0.5.0
```

npm `next` remains Harness `1.4.0-rc.8` and Code `0.3.0-rc.8`. The Electron desktop application lives in the dedicated `Zhivex/zhivex-app` repository. This record certifies the tagged artifacts, not later source edits.
