# Zhivex Assistant — phase 5

Private, unpublished local product. Consumes only named public Harness exports.
See the [MVP plan](../../docs/ASSISTANT_MVP_PLAN.md),
[contracts](../../docs/ASSISTANT_CONTRACTS.md) and
[phase 1 guide](../../docs/ASSISTANT_HOST.md).

Implemented: general assistant profile, foreground persistent host, private Unix
transport, SQLite conversations/runs/approvals, durable activity replay, explicit
dead-owner recovery, client serialization and sanitized startup/shutdown logs.
The default profile exposes no tools. A trusted embedding application can supply
an explicit profile/catalog and MCP configuration; ordinary messages cannot.

Telegram private-chat integration, explicit owner pairing, persistent input/output
queues and chat approvals are implemented. See the [Telegram guide](../../docs/ASSISTANT_TELEGRAM.md).
Google Calendar OAuth, durable proposals and Telegram-approved conditional event
updates are implemented. See the [Calendar guide](../../docs/ASSISTANT_CALENDAR.md)
for setup, profile-directory compatibility and recovery limits. A persistent daily agenda scheduler and explicit personal preferences are implemented;
see [automations](../../docs/ASSISTANT_AUTOMATIONS.md). Activate from the paired chat
with `/daily 08:00 America/Argentina/Buenos_Aires`; use `/daily status` and `/memory list`.
This is a single-owner local host, not a remote gateway or an OS-managed daemon.

## Development

Use Bun for packages, builds and tests; Node 22.13+ for the built host.
Phase 1 requires the **local Harness candidate**: the registry 1.6.3 pin does not
contain the new experimental `createProfiledHarness` export yet. No version has
been published or silently claimed compatible with that older artifact.

From the repository root:

```sh
bun run build
bun run --cwd packages/assistant prepare:local
bun run --cwd packages/assistant typecheck
bun run --cwd packages/assistant test
bun run --cwd packages/assistant smoke
```

`prepare:local` packs the existing build and installs the artifact with Bun
`--no-save --ignore-scripts`; it does not rewrite package.json or bun.lock.
A normal `bun install` restores the registry dependency and requires running
`prepare:local` again. Rebuild Harness first after engine changes.

For isolated installed-package acceptance:

```sh
bun run --cwd packages/assistant smoke:installed
```

This installs a temporary candidate consumer, checks resolution, types and tests,
and runs the offline example with Node. Host tests launch separate Node processes,
kill/recover the service, resume an exact approval and check conversation context.
Dependency installation may require network access; no model API is called.

## Abrir y configurar desde la web

Abrí `release-artifacts/Zhivex Assistant.app` con doble clic (macOS). El modo
administrado abre el navegador, permite configurar el modelo y las conexiones,
y guarda los secretos en el llavero del sistema. No requiere terminal durante
el onboarding. Ver [guía web de primera sesión](../../docs/ASSISTANT_WEB_ONBOARDING.md).

Para generar el lanzador desde esta copia preparada:
`bun run --cwd packages/assistant build:launcher`. Es un lanzador local que
requiere este checkout y Node; todavía no es una distribución autónoma firmada.

## Run (host CLI avanzado)

Choose a short private path because Unix sockets have a path-length limit:

```sh
bun run --cwd packages/assistant start --directory "$HOME/.zhx-a" --owner local-owner --provider openai
```

Configure the provider credential in the environment. The ready JSON contains a
private credential-file path, never its token. Keep this process running. SIGINT
or SIGTERM stops admission and drains accepted work; pending approvals survive.
Restart with the same directory, owner, provider/model and profile configuration.
After a crash, add `--recover`; recovery refuses a live owner and never replays
an uncertain effect. See the guide for client calls and recovery limits.

## Structure

- `src/contracts.ts`: draft versioned records for later product integrations.
- `src/host.ts`: private directories, immutable host binding, engine/service lifecycle.
- `src/client.ts`: negotiated local commands, serialized mutations and activity replay.
- `src/cli.ts`: foreground service and signal handling.
- `src/runtime.ts`: minimal one-task embedding example, not the conversation API.
- `src/telegram/`: Bot API adapter, separate SQLite queues and owner/approval bridge.
- `src/calendar/`: OAuth, encrypted credentials, event proposals and operation reconciliation.
- `src/automation/`: timezone scheduling, explicit preferences and read-only daily summaries.
- `tests/`: record validation and real-process recovery acceptance.
- `scripts/`: local candidate setup and isolated installed-package acceptance.

Assistant's `state/host.json` stores its owner/profile binding. Harness owns its
session and run database under `workspace/.zhivex-harness`. Assistant never reads
or writes its internal tables. Schema validation alone is not authorization.

Enable Telegram with `--telegram-owner NUMERIC_ID` and `ASSISTANT_TELEGRAM_BOT_TOKEN`.
Follow the locally printed pairing challenge. Existing webhooks are never removed
automatically. The token stays in memory, and uncertain sends are not auto-retried.

## Pilot onboarding

Para probar hoy con Calendar, Telegram y la web local, seguir el
[recorrido de primera sesión](../../docs/ASSISTANT_FIRST_DAY.md).

Follow the [complete pilot guide](../../docs/ASSISTANT_PILOT.md) for offline preflight
(`--doctor`), Google consent, Telegram pairing, recovery and the three-day acceptance
record. Local validation does not certify a live account or a completed pilot.

## Configurable providers and modules

Use `--config /path/assistant.json` for an explicit OpenAI-compatible provider and
composed Calendar/MCP modules. See [configuration, extension contract and compatibility](../../docs/ASSISTANT_EXTENSIONS.md).
The instance remains single-owner. Existing Calendar-only profiles remain compatible;
changing provider or composing additional modules requires a fresh runtime directory.

## Web local

La interfaz web incluye agenda, conversaciones, revisión de acciones y edición del
resumen diario. Agregá `--web` al comando de inicio y abrí el enlace privado que
imprime el host. Ver [guía web](../../docs/ASSISTANT_WEB.md) para ejecución, demo,
seguridad local y límites del piloto. La demo visual se inicia con
`bun run --cwd packages/assistant dev:web` y `?demo=1` en la URL.

### Muse / Meta y Qwen

El onboarding web ofrece Muse / Meta y Qwen con sus adaptadores nativos del
harness. No requieren configurar el protocolo. La búsqueda web integrada sigue
siendo exclusiva de OpenAI. Los perfiles anteriores permanecen compatibles.

Para configuración CLI v1, el campo `provider` también admite:

```json
{ "kind": "meta", "model": "muse-spark-1.3", "apiKeyEnv": "MODEL_API_KEY" }
```

```json
{ "kind": "qwen", "model": "qwen3.6-plus", "apiKeyEnv": "DASHSCOPE_API_KEY", "region": "singapore" }
```

Usá un modelo habilitado en tu cuenta. Qwen admite `workspaceId` y las regiones
`singapore`, `beijing`, `hong-kong`, `tokyo`, `frankfurt` y `virginia`. Fuera de
Singapur se requiere un workspace explícito; sin workspace se conserva el
endpoint internacional del SDK. Las claves se leen de la variable indicada y
no se incluyen en el archivo JSON. En la API TypeScript, pasá esta configuración
como `assistantProvider` a `startAssistantHost`; `compatibleProvider` sigue
aceptando las configuraciones OpenAI compatibles anteriores.

Para QwenCloud, agregá `"service": "qwencloud"` a la configuración Qwen
(por ejemplo con `"model": "qwen3.8-flash"`). Para una clave de Token Plan,
usá `"service": "token-plan"`. Estas rutas no requieren región ni workspace.
Omitir `service` conserva Model Studio y los perfiles existentes.
