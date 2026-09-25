# Model catalog administration

CLI and Desktop share `src/models/catalog.json`. Edit this file to curate the models; no UI list needs a separate edit. Validate with `bun run models:check`, then review and commit the manifest. The runtime embeds this validated catalog during builds.

## Curating models

Each provider has a `defaultModel` and a list of models. IDs are scoped to their provider. Every entry includes:

- `id`, `name`, `order`: API model ID, display label and ordering within its group.
- `group`: `primary` (recommended shortlist) or `other` (additional choices).
- `lifecycle`: `active`, `deprecated`, `retired` or `unknown`, describing the upstream provider's lifecycle, independently of recommendation.
- `validation`: `verified` or `unverified`, describing Zhivex compatibility evidence. Mark verified only after validating that exact provider/model route.
- `capabilities`: `chat`, `tools`, and optionally `vision`.
- Optional `reason`, `replacement` (same-provider ID) and `retirementDate` (`YYYY-MM-DD`).

To demote a model, set `group` to `other`, record a short `reason`, and optionally a `replacement`. If it is the default, first choose another primary model as `defaultModel`. Do not infer retirement from age or remove models merely because they are no longer recommended. Retain historical entries to explain existing selections. The shortlist tracks the explicitly selected defaults. Provider lifecycle is updated only with source evidence; Zhivex validation remains unverified until that exact route is tested.

Increment the human-readable `revision` for each publication. Defaults must reference primary, non-retired entries. IDs must be unique per provider and replacements must exist. Unsupported providers, unknown fields and control characters are rejected. This catalog does not install new provider adapters.

`bun run models:import /absolute/path/to/zhivex-ai-sdk` imports new chat/tool suggestions into `other`, preserving existing curation and historical entries. Review the resulting diff and validate before publication.

## Remote distribution

Publish the exact validated JSON to an HTTPS location you administer (for example, a raw file in your catalog repository or static hosting). Configure the **same** `ZHIVEX_MODEL_CATALOG_URL` environment variable in the CLI and in the environment that launches Desktop. No remote endpoint is assumed or published by this change. Without this setting, both use the bundled catalog.

Clients fetch when opening the model chooser (Desktop also fetches during its initial provider load). A valid cache is reused for one hour. Relaunch with the variable unset to use only the bundled snapshot. The setting must reach the Desktop process; a shell variable alone does not configure an app launched from Finder.

Remote responses are limited to 1 MiB, time out after 3 seconds, require HTTPS, and disallow redirects and URL credentials. Catalogs cannot change credentials, API endpoints, adapters or executable behavior. CLI and Desktop share an atomic, URL-specific cache in `~/.zhivex/model-catalog`. Invalid data or unavailable networking falls back to the last valid cache, then the bundled catalog. The chooser indicates a failed refresh. No generation call or account entitlement check is performed by catalog refresh.

To roll back, republish the earlier valid manifest at the same URL; clients accept it at the next refresh (within an hour). Revisions are labels, not an anti-rollback sequence.

## Selection behavior

Both selectors expose Primary models, Other models, and a custom ID option. Desktop searches across names, IDs and providers, expanding Other models for search results. Deprecation details and replacements accompany model choices.

Catalog refresh never writes project or conversation selections and never silently migrates a selected model. A current ID missing from the catalog stays visible. Retirement is metadata, not proof of account access or an execution block; the provider decides whether a request is accepted. Remote defaults guide explicit choices in the selector. Runtime startup defaults remain the bundled defaults, preserving startup behavior without requiring networking.

The source manifest is the administration interface for this first version. A private web editor can later validate and publish the same schema without changing either client.

## OpenAI catalog refresh — 2026-09-22

Revision `2026-09-22.2` lists GPT-6 Astra, Sol and Luna, followed by GPT-5.6 Sol, Terra and Luna as primary choices. GPT-5.5, GPT-5.4, GPT-5.4 Mini and GPT-4o Mini remain under Other models; this editorial grouping does not claim provider deprecation. Revision `2026-09-22.4` selects `gpt-6-luna` as the default for new CLI/Desktop choices. Explicitly saved model selections remain unchanged; release certification requires fresh evidence.

The official [model catalog](https://developers.openai.com/api/docs/models), [GPT-6 Sol page](https://developers.openai.com/api/docs/models/gpt-6-sol) and [GPT-6 Luna page](https://developers.openai.com/api/docs/models/gpt-6-luna) were checked on 2026-09-22. The new API IDs are `gpt-6-sol` and `gpt-6-luna`; their documented capabilities include text, image input and function calling. Both recommend Responses for tools; Chat Completions function calling requires reasoning effort `none`. No authenticated generation or account entitlement check was performed, so their Zhivex validation stays `unverified`.

## Qwen default — 2026-09-22

Revision `2026-09-23.2` restores `qwen3.8-max` as the bundled Qwen default for CLI, Desktop and RC.10 live certification. Max is Primary; `qwen3.8-flash` remains available under Other models. Existing profiles and conversation model selections are preserved. Max remains `unverified` for this candidate until its exact release-bound route passes certification.

## Context limits and compaction advice

Revision `2026-09-24.1` adds optional metadata without invalidating older schema-version-1 manifests. Older clients with a strict parser reject enriched manifests and fall back to their cache/bundle; upgrade clients before publishing the enriched manifest remotely.

- `limits` records `contextWindowTokens`, `contextWindowType` (`combined` input plus output, or independently documented `input`), `maxOutputTokens`, and optional conservative `maxInputTokens`. Never infer limits from a name or another model version.
- `pricing` records USD per million input/output tokens, optional cached-input price, a `scope` explaining the applicable tier and exclusions, and optional `maxInputTokens` above which the recorded rates must not be extrapolated. These are estimates, not billing guarantees. Regional or subscription pricing may differ.
- `compaction.suitability` is `candidate`, `evaluated`, `unsuitable`, or `unknown`. Candidate is an editorial inference from documented text capabilities. Evaluated requires a summary-fidelity evaluation with a referenced report, not just provider marketing or a successful generation.
- Each metadata group requires HTTPS `evidence.sourceUrl` and `evidence.checkedAt` (`YYYY-MM-DD`). Missing metadata means unknown, not zero or unlimited. Source links are evidence only and are never fetched automatically by recommendations.

The first curated limits cover GPT-6 Astra/Sol/Luna, GPT-4o Mini, Qwen 3.8 Max/Flash, and Gemini 3.5 Flash-Lite/3.6 Flash/3.7 Flash/3.8 Flash. Values were checked against each model's official page on 2026-09-24; exact links and dates are embedded in the JSON. Qwen uses the lower documented thinking-mode input ceiling. Initial pricing covers those four OpenAI models and Gemini 3.5 Flash-Lite; other prices remain unknown rather than assuming a region. Other existing model IDs remain available, with unknown limits. No entry is promoted to Zhivex `verified` by adding provider documentation.

`recommendCompactionModels(catalog, request)` is a pure advisory function. Its request includes a provider, estimated full input tokens (including instructions and wrappers), reserved output tokens, an optional allowlist of available models, and an optional clock/evidence age (90 days by default). It never changes the configured model, credentials, provider, or catalog defaults. It excludes unknown/stale limits, missing suitability, retired/deprecated models, and insufficient input/output capacity. Results expose exclusion reasons, route/quality warnings, and scoped cost estimates where known. Future-dated evidence is not considered fresh.

Ranking prefers known estimated cost, then catalog order and ID. Unknown prices sort behind known prices; this does not claim that an unpriced model costs more. Legacy `evaluated` labels without an evaluation artifact are treated as candidates and reported with `compaction_evaluation_evidence_missing`; a label alone does not earn a quality preference. Pricing above an undocumented tier produces a warning and no estimate. Supply `availableModels` when account availability is known. An explicitly configured model remains the user's choice, including a custom ID; recommendations are never an automatic cross-provider fallback. Runtime token guards and actual usage accounting remain authoritative.


## Shared SDK recommendation engine

The harness uses `@zhivex-ai/core` 1.24.0 `createModelCatalog` and `recommendAuxiliaryModel` for limit validation, per-datum evidence freshness and cost estimates. `src/models/sdk-catalog-adapter.ts` adapts the existing version-1 manifest into that contract, converting USD per million tokens into the SDK's per-thousand units. It retains missing values, provider/model identities and exact source dates. Pricing above a locally recorded tier ceiling is omitted rather than extrapolated. Combined windows reject output limits larger than the window; separately published input windows allow independent output limits.

The harness retains its curated inventory, defaults, chooser ordering, lifecycle policy and route validation labels. The core package's `defaultModelCatalog` is an explicitly frozen compatibility inventory, so it is not used to replace the current manifest. Release-managed upstream inventory lives in `@zhivex-ai/sdk`; `models:import` remains an explicit curation workflow. This integration removes duplicate recommendation calculations, without introducing an automatic inventory migration or depending on an unpublished checkout.

The SDK requires an evaluation artifact with source, fixture, version, date and pass result for evaluated compaction quality. The current manifest's `evaluated` label has only generic evidence, so the adapter conservatively emits a candidate plus a warning instead of inventing an evaluation. Host lifecycle restrictions and compaction curation freshness remain additional harness checks; public recommendation arguments, return shape and existing reason codes are preserved. Recommendations remain advisory and never authorize credentials or automatically switch providers.
