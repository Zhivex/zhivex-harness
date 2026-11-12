# Assistant: first usage session

Goal: try a useful flow today and record reproducible problems.
This starts the pilot; it does not replace the three acceptance days in
[ASSISTANT_PILOT.md](ASSISTANT_PILOT.md).

For the terminal-free flow, use [web onboarding](ASSISTANT_WEB_ONBOARDING.md).
The following commands apply to the technical pilot and advanced CLI host.

## Preparation

From the repository root:

```sh
bun run prepare:assistant
bun run --cwd packages/assistant build
bun run --cwd packages/assistant typecheck
```

Set the credentials described in pilot onboarding in the terminal.
Do not paste secrets into conversations or reports. OpenAI requires
`OPENAI_API_KEY`; Qwen requires `DASHSCOPE_API_KEY` or `QWEN_API_KEY` and
`--provider qwen`. Always use the same provider/model and directory when restarting.
If an instance already exists, preserve its options and encryption key.

The following commands use OpenAI and a new directory as examples.
Replace `123456789` with the owner's numeric Telegram account ID:

```sh
bun run --cwd packages/assistant start --doctor --directory "$HOME/.zhx-pilot" --owner local-owner --provider openai --calendar --telegram-owner 123456789 --web
```

Continue when it returns `ok: true`. This is an offline diagnostic: it checks
local configuration but does not authenticate with Google, Telegram or the model.
With the host stopped, connect Calendar if it is not already connected:

```sh
bun run --cwd packages/assistant start --directory "$HOME/.zhx-pilot" --owner local-owner --calendar-connect
```

Open the local OAuth URL and complete consent with the test account.
Then start the host and leave the terminal open:

```sh
bun run --cwd packages/assistant start --directory "$HOME/.zhx-pilot" --owner local-owner --provider openai --calendar --telegram-owner 123456789 --web
```

Open the `assistant-web` link. Link Telegram by sending the bot a private
`/start CODE` message using the code printed in that terminal. The web link and linking code
are private. The Vite interface with `?demo=1` uses simulated data: for this test,
use only the host link.

## 30–45 minute walkthrough

Use test events and attendees under your control. Approved modifications
can notify event attendees.

| Step | Action | What to check |
| --- | --- | --- |
| 1 | Open the web schedule and ask via Telegram, “Show me today's schedule and its conflicts.” | Account, date, zone and events match Calendar. |
| 2 | Ask to move a test event to a specific time. | The proposal shows event, time and attendees; Calendar stays unchanged before approval. |
| 3 | Reject that proposal. | The event does not change. |
| 4 | Request another proposal and approve it once from its review. | Calendar reflects the exact change; record any unexpected notification. |
| 5 | Leave a proposal pending, stop with Ctrl+C and wait for `assistant-stopped`. Restart with the same command. | The review remains available. If expired, cancel and propose again. Open the new web link. |
| 6 | Schedule the summary a few minutes ahead from the web or `/daily HH:mm America/Argentina/Buenos_Aires`. | `/daily status` shows the next time; a summary arrives and matches the schedule. Keep the host running. |
| 7 | Send `/daily pause`. | Paused status; no new runs remain enabled. |

Web and Telegram let you check each surface; do not assume they create the same
conversation. The summary requires Calendar and linked Telegram. Its content is
deterministic: it does not yet execute general instructions such as researching news.

Do not use `--recover` for a normal restart. Reserve it for an actual crash and
follow the pilot recovery guide. If a response is lost, inspect
state before repeating the action.

## Record results

Save a private copy of this table and complete one row per attempt:

| Time and zone | Scenario | Expected | Observed | Approximate duration | Manual interventions | Available run/operation ID | Outcome |
| --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | | Pending |

Suggested outcomes: completed, blocked, incorrect or uncertain. Also record
confusing steps, unnecessary approvals and automation opportunities.
Keep the code revision (`git rev-parse HEAD`) and note local changes
if applicable. Do not attach databases, credentials, private links or
personal content to the shared report.

If an unapproved write, wrong account, duplication or unexplained uncertain effect
occurs, stop the process and preserve state for diagnosis.
At the end of the session, leave the summary paused or delete it with `/daily delete`.
If continuing the pilot another day, keep credentials and directory; final
revocation is described in the pilot guide.
