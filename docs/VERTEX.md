# Google Cloud Vertex AI (provisional)

Vertex is a separate provider (`vertex`), using Google Cloud Application Default
Credentials (ADC). A Gemini API key does not configure this route. The bundled
`gemini-3.7-flash` selection is unverified; its pinned SDK requires `global`.
Use a model enabled for your project and location. No live certification,
pricing or context limits are inferred from the Gemini direct API.

## Configuration

Configure ADC on the host using your organization's Google Cloud workflow.
Local application-default credentials, an explicit ADC credential file, and
attached cloud identities are resolved by `google-auth-library`. Tokens are
cached and renewed by that library, not stored in Harness sessions or Keychain.

Set `GOOGLE_CLOUD_PROJECT` and `VERTEX_LOCATION` explicitly in the launching
environment. Set `GOOGLE_APPLICATION_CREDENTIALS` to an ADC file if required by
your deployment. Otherwise the host's standard ADC discovery applies. Harness
does not edit credential files or run a login flow. Static `VERTEX_ACCESS_TOKEN`,
`GOOGLE_ACCESS_TOKEN`, `VERTEX_API_KEY` and `GOOGLE_API_KEY` do not override ADC.
Custom Vertex endpoints are not supported by this integration.

Select `vertex` through the CLI provider selector or `--provider vertex`, then
choose your model. The CLI credentials screen explains ADC instead of asking for
an API key. In Desktop, launch the app with the same environment and select
Google Cloud Vertex AI in the model selector. The credentials screen checks
route configuration and can request an ADC token; it does not store/delete ADC.
Restart Desktop after changing its project or location.

Configuration presence is not an authentication or model-access check. ADC
renewal and generation can still fail due to expired grants, missing credentials,
IAM, model/region availability, quota or service errors. The ADC button only
checks token acquisition; it does not certify model access or issue generation.

## Durable execution and diagnostics

Project, location and the explicit ADC-file path are hashed into the durable
transport binding. A changed route cannot approve a run created on another route.
Token renewal does not change the binding. Account changes behind the same ADC
file remain governed by Google Cloud IAM; Harness does not fingerprint tokens.
Unconfigured Vertex does not change existing provider transport bindings.

Errors expose bounded categories for authentication, permission, unavailable
model/route, rate limit and server failures. Raw Google payloads, token values,
credential paths and service-account identities are not retained in errors.

The integration pins `@zhivex-ai/vertex@1.1.2` with Core 1.26.0 and
`google-auth-library@11.0.2`. Deterministic tests exercise the installed SDK's
transport, streaming, signed continuation, approval/reopen and route mismatch.
They are not evidence of a live project, renewable ADC or IAM authorization.
