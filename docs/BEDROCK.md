# Amazon Bedrock (provisional)

Bedrock is a separate provider (`bedrock`). It is not enabled by the Anthropic
direct API route. No live Harness certification has been run for this route.
Pricing and context limits are not inferred.

Published `@zhivex-ai/bedrock@2.0.7` is the adapter pinned by this tree. It
requires Core `^1.34.0`, and this checkout pins `@zhivex-ai/core@1.34.0`.
This integration reports the installed adapter's labels and does not relabel
them.

## Runtimes

`BEDROCK_RUNTIME` is optional. An empty value or `converse` selects the Converse
API. `openai` selects the OpenAI-compatible runtime. Any other value is rejected.

Converse reports Tier B on the published 2.0.7 adapter: reasoning is supported
and `toolChoiceNone` is true. Approval requests stay false on that runtime.
Harness reports that installed label.

The OpenAI-compatible runtime reports Tier A, including approval requests.
It needs `BEDROCK_API_KEY` or `AWS_BEARER_TOKEN_BEDROCK`, plus an https
`BEDROCK_OPENAI_BASE_URL` with no user, password, or fragment. Harness does
not read `OPENAI_API_KEY` or `OPENAI_BASE_URL` for this route.

## Credentials

Converse uses the AWS SDK default credential chain: instance roles, SSO,
shared config, and environment credentials. Set `AWS_REGION` or
`AWS_DEFAULT_REGION` to a region such as `us-east-1`. `AWS_PROFILE` is part of
the transport fingerprint. Published 2.0.7 accepts a profile and static
credentials on the adapter. This route does not pass `AWS_PROFILE`. When
`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` are both set, and no bearer
token is set, Converse uses that static pair and an optional
`AWS_SESSION_TOKEN`. Otherwise the AWS SDK default chain applies. Harness
does not call AWS while checking that the route is configured. Incomplete
settings, such as a profile or runtime with no region or OpenAI route, stay
out of the durable transport fingerprint.

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
