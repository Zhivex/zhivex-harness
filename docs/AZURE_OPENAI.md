# Azure OpenAI (provisional)

Azure OpenAI is a separate provider (`azure-openai`). It does not reuse
`OPENAI_API_KEY` or `OPENAI_BASE_URL`. No live Harness certification has been
run for this route. Prices are not copied from the public OpenAI catalog.

Published `@zhivex-ai/azure-openai@0.7.7` is the adapter pinned by this tree.
It is compatible with the Harness Core 1.31.0 pin. Language models report
Tier A. Hosted tool gates such as tool search follow the model id
(`gpt-5.4` and `gpt-6-astra` in this adapter). An opaque deployment name does
not receive those gates unless a deployment map names the base model.

SDK pull request 165 adds a first-class deployments map and a token provider
for Microsoft Entra ID. That package is not published. This integration does
not pretend Entra token auth works on 0.7.7. The published auth path is an API key.

## Configuration

Set `AZURE_OPENAI_ENDPOINT` to an https URL with no user, password, query, or
fragment. Set `AZURE_OPENAI_API_KEY` in the environment, or store it in the CLI
keychain or a temporary session. The endpoint is required with a managed key.
It is not treated as an override that blocks the keychain.

`AZURE_OPENAI_API_VERSION` is optional. When it is set, requests use
`/openai/deployments/{deployment}/chat/completions?api-version=...` and the
deployment name is not also sent as `model`. When it is omitted, requests use
`/openai/v1/chat/completions` and the body includes the model id.

`AZURE_OPENAI_DEPLOYMENTS` is optional JSON, at most 8192 characters and 32
entries. Each entry is `"name": "gpt-5.4"` or `"name": { "model": "gpt-5.4" }`.
Deployment names and model ids are restricted to simple identifier characters.
Harness passes the map through for a later SDK and, on 0.7.7, overlays the
base model's capability flags while the request still uses the deployment name.

The published adapter also reads omitted endpoint, key, and API version from
`process.env`. Harness passes the endpoint and key from the selected
environment. When that environment omits the API version, Harness hides
`process.env.AZURE_OPENAI_API_VERSION` for the adapter constructor so a host
value cannot change the route.

## Durable execution

Endpoint, API version, and the deployments document are hashed into the durable
transport binding. The API key is not. Unconfigured Azure OpenAI does not
change existing provider transport bindings.

Provider errors are replaced with a generic message. Numeric status and the
retryable flag are kept. Response bodies and the API key are dropped.

Deterministic tests stub `fetch`. They do not contact Azure and they do not
check account access.
