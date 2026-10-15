# Amazon Bedrock (provisional)

Bedrock is a separate provider (`bedrock`). It is not enabled by the Anthropic
direct API route. No live Harness certification has been run for this route.
Pricing and context limits are not inferred.

Published `@zhivex-ai/bedrock@2.0.6` is the adapter pinned by this tree. It is
compatible with the Harness Core 1.31.0 pin. SDK pull request 165, which marks
Converse as Tier B and accepts explicit profile and static credentials, is
merged upstream and not yet published. This integration does not relabel the
installed adapter.

## Runtimes

`BEDROCK_RUNTIME` is optional. An empty value or `converse` selects the Converse
API. `openai` selects the OpenAI-compatible runtime. Any other value is rejected.

Converse is Tier B in the SDK matrix after pull request 165. The published
2.0.6 adapter still reports `supportTier: "tier-c"`: reasoning is unsupported
and `toolChoiceNone` is false. Harness reports that installed label.

The OpenAI-compatible runtime reports Tier A, including approval requests.
It needs `BEDROCK_API_KEY` or `AWS_BEARER_TOKEN_BEDROCK`, plus an https
`BEDROCK_OPENAI_BASE_URL` with no user, password, or fragment. Harness does
not read `OPENAI_API_KEY` or `OPENAI_BASE_URL` for this route.

## Credentials

Converse uses the AWS SDK default credential chain: instance roles, SSO,
shared config, and environment credentials. Set `AWS_REGION` or
`AWS_DEFAULT_REGION` to a region such as `us-east-1`. `AWS_PROFILE` is part of
the transport fingerprint. The published adapter does not take a profile or
static credential object, so the AWS SDK reads the profile from the host
environment when a request is sent. Harness does not call AWS while checking
that the route is configured.

An explicit `AWS_BEARER_TOKEN_BEDROCK` in the Harness environment selects bearer
auth for Converse and skips the default chain. The CLI does not store a Converse
API key. The OpenAI-compatible runtime can use a keychain or temporary
`BEDROCK_API_KEY` together with the required base URL.

## Durable execution

Region, default region, profile, runtime, and the OpenAI base URL are hashed
into the durable transport binding. API keys and bearer tokens are not.
Unconfigured Bedrock does not change existing provider transport bindings.

Provider errors are replaced with a generic message. Numeric status and the
retryable flag are kept. Response bodies, account identifiers, and credentials
are dropped.

Deterministic tests mock the AWS client and the OpenAI-compatible HTTP call.
They are not evidence of model access, IAM, or a live region.
