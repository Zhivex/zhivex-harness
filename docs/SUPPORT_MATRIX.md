# Support matrix for 1.0

The machine-readable source is [`support-matrix.json`](./support-matrix.json). `supported` means the combination has a release-relevant automated gate. `secondary` means it is exercised but is not the primary release runtime. `provisional` means the integration exists without enough end-to-end evidence for the 1.0 guarantee. `unsupported` is an explicit boundary.

| Dimension | Supported | Secondary | Provisional | Unsupported |
| --- | --- | --- | --- | --- |
| Runtime | Node.js 22.13+, Node.js 24 | Bun 1.4+ | — | older Node |
| OS | Linux, macOS | — | — | Windows |
| Store | SQLite | file migration backend | — | remote managed store |
| OCI | Docker on Linux | — | Podman | managed remote sandbox |
| Target package manager | npm | Bun | pnpm, Yarn | — |
| MCP | bounded Streamable HTTP | — | broader remote implementations | stdio |
| Provider | Meta `muse-spark-1.2`, Qwen `qwen3.8-max`, OpenAI `gpt-5.6-luna` | — | Gemini | undocumented providers |

Provider evidence is release-, account-, endpoint-, model-, and date-bound. A provider is supported for a release only when the exact candidate passes base, orchestration, routing, and model-directed execution gates. The table does not imply upstream feature parity.

Podman, pnpm, and Yarn remain provisional until they have real end-to-end gates. Windows and stdio MCP are outside the 1.0 contract.
