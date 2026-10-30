# Slack Agent Connector

Connect any DevRev AI agent to a Slack app. Bot DMs and `@mentions` create a durable DevRev DM with the agent, and the agent's replies return to the Slack thread.

The snap-in is agent-, org-, environment-, user- and Slack-app-agnostic. **Install it once per connection.** Each install has its own Slack app, agent, act-as user and state; nothing is hardcoded to an org or environment.

## Installing a connection

1. Create a Slack app for the connection (its name and avatar are what Slack users see) and install it to the workspace. Grant the scopes listed below.
2. Install this snap-in in the target DevRev org. Create a `snap_in_secret` keyring holding the app's bot token (`xoxb-…`) as `slack_connection`.
3. Fill in the inputs:

| Input | Description |
|---|---|
| `agent_id` | DON of the AI agent to invoke. Must belong to the org the snap-in is installed in. |
| `act_as_user_id` | DON of the DevRev user that owns every invocation. Must belong to the same org as the agent. |
| `display_name` | Optional. How the agent is named in Slack failure replies, e.g. `UI Ops agent`. Default `DevRev agent`. |
| `debug_errors` | Optional, default `false`. When `true`, Slack failure replies append `[debug] step=<stage>: <METHOD path [status] message>`, redacted and trimmed to 500 characters. Keep off in production. |

Activation validates that `agent_id` and `act_as_user_id` belong to the installed org (derived from the event, not configured), checks the Slack token with `auth.test`, installs the schemas, and **claims the Slack app for this install**. A second install pointing at the same Slack app is rejected, because two pollers would answer every message twice. Use one Slack app per install.

## How it works

1. A `timer-events` source fires every minute (`slack_poller`). It lists the bot's conversations (`users.conversations`, including IMs) and reads each with `conversations.history` from its stored cursor. There is no inbound webhook, relay route or public URL.
2. A human DM or an explicit `@mention` from a person or another bot invokes the configured agent, or records an intake receipt in workflow mode. The connector ignores its own posts, system messages and untagged bot messages, including in DMs.
3. The agent's reply is posted back to the Slack thread (`devrev_handler`).
4. Threads the agent has answered are watched for 24 hours, so follow-ups reuse the same DevRev DM and the agent keeps prior context.

## Polling state and exactly-once delivery

State lives in two custom objects installed by the activation hook. They are shared by all installs in an org; **every unique key is prefixed `slack_agent_connector:<install id>:`**, so installs never read or write each other's cursors or receipts.

- `slack_connector_state`: a `global` record (install marker, last tick, JSON tick `status`), one `channel:<id>` cursor per conversation, `thread:<channel>:<ts>` watches, and the `slack_app:<app id>` claim.
- `slack_connector_receipt`: one `receipt:<channel>:<ts>` write-ahead receipt per dispatched message.

Rules:

- **First run** sets every cursor to "now"; no history is backfilled. A channel joined later starts 5 seconds before the previous tick.
- **Ordering.** Messages are processed oldest first. The cursor advances only past messages that were fully handled; a message that cannot be dispatched blocks later ones in that conversation until it succeeds.
- **No duplicates.** A receipt is claimed (the unique key rejects a second claim) before dispatch and marked `done` after. A `done` receipt is never dispatched again, even if the cursor write was lost.
- **Crash recovery.** The DM ID is recorded on the receipt before the executing comment (`external_ref = slack:<channel>:<ts>`) is posted. When a claim is older than 10 minutes and not `done`, the poller checks that DM for the comment: if found it marks the receipt `done`, otherwise it retries.
- State objects are shared read-only with `act_as_user_id` so operators can inspect them.

## Required Slack bot scopes

`chat:write`, `chat:write.customize`, `reactions:write`, `users:read`, `users:read.email`, `metadata.message:read`, `files:read`, `files:write`, and for polling: `channels:read`, `channels:history`, `groups:read`, `groups:history`, `im:read`, `im:history`, `mpim:read`, `mpim:history`. The tick `status` lists scopes that are granted or missing.

## Key design decisions

- **Configured identity.** Every invocation acts as `act_as_user_id` through a per-request act-as token, never cached. There is no stored PAT. Slack users do not need DevRev accounts. If that user is deactivated, the connection stops working.
- **Unified DM path.** Channel mentions and bot DMs both use the DM-with-agent path for durable history.
- **Follow-up tracking.** The DM stores a `last_imported_ts` watermark; follow-ups import only newer Slack messages.
- **Ingress is a poll.** Latency is up to about one minute and each tick has a 45-second budget. The optional Events API ingress below delivers in seconds; the poller stays on as the safety net.

## Events API ingress

An optional second ingress delivers app mentions and DMs in seconds. It runs the same path as the poller (`SlackPoller.handleMessage`: qualification, author check, receipt claim, thread watch), so a message that arrives through both ingress paths is handled once. The `slack-events` source routes to the existing `devrev_handler` function (no extra function). The poller keeps running and covers anything the webhook drops or misses.

Setup, once per install:

1. In the Slack app's Event Subscriptions, enable events and set the Request URL to the install's `slack-events` trigger URL. The source answers Slack's `url_verification` challenge itself.
2. Subscribe to the bot events `app_mention`, `message.im` and `message.mpim`, and add the `app_mentions:read` scope.
3. Turn Socket Mode off, and turn on the App Home Messages tab so people can DM the app.
4. Put the app's signing secret in the optional `slack_signing_secret` keyring. Without it every delivery is logged and dropped.

The handler verifies the v0 HMAC-SHA256 signature (timing-safe) and refuses requests older than 5 minutes. It accepts only `event_callback` payloads for `app_mention`, or `message` in an `im` or `mpim`, and ignores deliveries whose `api_app_id` is not the install's Slack app.

## Migrating from the per-agent snap-ins

`playwright-agent-from-slack` and `ui-ops-agent-from-slack` are the same code with names changed. Replace each with an install of this snap-in. Inputs map as `playwright_agent_id` / `ui_ops_agent_id` to `agent_id`, and `qa_user_id` to `act_as_user_id`. Old state is not reused: the first run of the new install sets fresh cursors and backfills nothing. **Deactivate the old install before activating the new one**, since both would poll the same Slack app.

## Verification sequence

1. **Identity proof.** The snap-in mints an act-as token for `act_as_user_id` and creates a DM with the agent.
2. **Context proof.** A multi-author thread is delivered in order without omission.
3. **Slack end-to-end proof.** A channel mention and a bot DM each receive one reply in the correct thread.
4. **Follow-up proof.** A second message reuses the existing DevRev DM and the agent uses prior context.
5. **Exactly-once proof.** Each message has one `done` receipt and one executing comment.
6. **Isolation proof.** A second install on a different Slack app in the same org keeps separate cursors, and a second install on the same Slack app is refused.
