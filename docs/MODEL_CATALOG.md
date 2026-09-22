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

To demote a model, set `group` to `other`, record a short `reason`, and optionally a `replacement`. If it is the default, first choose another primary model as `defaultModel`. Do not infer retirement from age or remove models merely because they are no longer recommended. Retain historical entries to explain existing selections. The shortlist preserves the previous defaults. Provider lifecycle is updated only with source evidence; Zhivex validation remains unverified until that exact route is tested.

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

Revision `2026-09-22.2` lists GPT-6 Astra, Sol and Luna, followed by GPT-5.6 Sol, Terra and Luna as primary choices. GPT-5.5, GPT-5.4, GPT-5.4 Mini and GPT-4o Mini remain under Other models; this editorial grouping does not claim provider deprecation. The default remains `gpt-5.6-luna`.

The official [model catalog](https://developers.openai.com/api/docs/models), [GPT-6 Sol page](https://developers.openai.com/api/docs/models/gpt-6-sol) and [GPT-6 Luna page](https://developers.openai.com/api/docs/models/gpt-6-luna) were checked on 2026-09-22. The new API IDs are `gpt-6-sol` and `gpt-6-luna`; their documented capabilities include text, image input and function calling. Both recommend Responses for tools; Chat Completions function calling requires reasoning effort `none`. No authenticated generation or account entitlement check was performed, so their Zhivex validation stays `unverified`.
