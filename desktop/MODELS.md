# Models and credentials

Desktop uses the Harness providers: OpenAI, Qwen, Meta and Gemini. Gemini remains
provisional. Choosing a model does not establish remote availability or account access.

## Choose a model

Open a repository and click the model name below the editor (**Choose a model**).
Search by name or provider, select a card, then choose **Usar modelo**. For a custom
ID, open **Configurar otro modelo**, choose the provider and **Otro modelo…**.
**Volver** or Escape discards unconfirmed changes.

The selection persists per project across restarts. A new worktree task initially
inherits the source project's selection and then keeps its own. Changes affect
subsequent messages; previous runs retain their recorded provider and model.
Finish or cancel active runs, pending approvals and recovery in all conversations
of the project before changing the model. Changing a key does not cancel an active run.

## Add credentials

In **Credentials**, choose the provider and enter its key in the secure macOS
dialog. The open project reconnects afterward. Keys are stored in separate Keychain
accounts, not in the renderer, child-process arguments/environment or configuration files.
Without a key, history and settings remain accessible but sending is disabled.

## Connection scope

The app uses the adapters' default endpoints. Qwen uses international Model Studio
(Singapore) with standard credentials. Custom endpoints, other regional deployments
and special plans are not configurable in this interface. Shell overrides cannot
silently redirect credentials. The connection check lists models without generation;
it does not certify access to a particular model or its tool capability.

Contributor tests and their evidence limits are documented in [Development](DEVELOPMENT.md).
