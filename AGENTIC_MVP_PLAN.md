# MathHive One-Burst Agentic MVP Plan

## Mission

Turn the existing high-fidelity static MathHive mockup into a genuinely working,
small-team, multiuser MVP in one sustained Codex implementation run.

The finished system must preserve the current visual design while making every
major surface real:

- theorem spaces;
- URL-based joining with only a display name and short PIN;
- editable result nodes and dependency edges;
- realtime graph updates, presence, cursors, and activity;
- a mathematician-oriented Markdown/LaTeX editor with live rendering;
- revision-aware Codex feedback against drafts before submission;
- human submissions for validation;
- Codex-operated step-by-step proof validation through MCP;
- Codex-generated cross-space integration suggestions through MCP;
- Codex-created targeted notifications through MCP;
- suggestion inspection, acceptance, dismissal, and graph integration;
- comments, Codex reviews, revision history, stars, filters, layout, citations,
  and imports;
- browser-verified desktop and mobile rendering.

This is a draft MVP for tens of users, not thousands. Favor a complete vertical
slice over production architecture.

This plan defines a fully functional POC, not a visual simulation. The core demo
must work from two different machines or browser contexts: join from the shared
URL, write and preview mathematics, receive Codex draft feedback before
submission, submit for a deeper proof review, receive a validation decision, and
notify another user when the result is relevant to that user's active work.

### POC Coverage Contract

| Requirement | Required observable proof |
| --- | --- |
| Join with URL, name, and small password | A new user opens `/join/<slug>`, creates identity in one action, reloads into the same session, and a wrong PIN cannot reuse that name. |
| Appropriate mathematical input | The editor accepts LaTeX claims and hypotheses plus Markdown/LaTeX proof text, dependencies, citations, and shows a live rendered preview. |
| Suggestions before submission | After a draft editing pause, Codex reviews the exact saved revision through MCP and feedback appears in the open editor over WebSocket. |
| Manual AI validation | On submit, Codex restates the claim and records assumption, proof-step, dependency, notation, and counterexample checks before deciding. |
| Notify collaborators | Validation and draft feedback notify the author; relevance analysis notifies affected users immediately or on their next session. |
| Suggest work to relevant users | Codex compares validated results with other users' active drafts and produces targeted suggestions tied to source/target IDs and proposed graph changes. |
| Collective visualization | Accepting a suggestion updates nodes/edges, activity, notifications, and both connected browsers without reload; deterministic server checks protect the projection and Playwright verifies appearance. |

## The Key Speed Decision

Do not migrate the current vanilla HTML/CSS/JavaScript mockup to React. Keep its
DOM and styling, and replace its hard-coded arrays with server state.

Use one Node.js process for the web server, API, WebSocket hub, queue, and data
store. Persist the full application state to one JSON file after each durable
mutation. All writes run through the single Node process, so there is no
cross-process file locking problem.

Use a separate local stdio MCP process that calls the Node server's internal
HTTP API. It must never edit the JSON file directly.

```text
Browser A ---- HTTP + WebSocket ----+
Browser B ---- HTTP + WebSocket ----+---- Node app ---- data/store.json
Browser N ---- HTTP + WebSocket ----+
                                         ^
                                         | localhost internal API
                                         |
Codex exec ---- stdio MCP server --------+
```

This removes Supabase, React, a bundler, a database server, authentication,
CRDTs, vector search, background queues, and deployment-specific setup from the
critical path.

## Runtime Stack

- Node.js 22+
- `express` for static files and JSON APIs
- `ws` for realtime collaboration
- `@modelcontextprotocol/sdk` and `zod` for the local MCP server
- `@dagrejs/dagre` for the dependency layout endpoint
- `katex` for user-entered formulas
- `markdown-it` and `markdown-it-texmath` for proof Markdown with inline and
  display LaTeX
- `@playwright/test` for implementation-time two-browser tests and screenshots
- `concurrently` only to run the app and Codex queue watcher together
- Node's built-in `node:test` and `assert` for server tests

No frontend build step is required. Serve browser-ready scripts and CSS from
`public/`, and expose vendored browser assets from their installed packages.

## Required File Layout

The implementing agent should create this layout and move the existing three UI
files into `public/` without redesigning them:

```text
AGENTS.md
AGENTIC_MVP_PLAN.md
package.json
package-lock.json
.codex/
  config.toml
data/
  seed.json
  store.json                 # generated, ignored if git is initialized later
mcp/
  server.mjs
prompts/
  operator.md
public/
  index.html
  styles.css
  app.js
  api.js
  realtime.js
  editor.js
  join.js
  math-editor.js
server/
  app.mjs
  store.mjs
  model.mjs
  routes.mjs
  websocket.mjs
  queue.mjs
  layout.mjs
scripts/
  agent-watch.mjs
  seed.mjs
tests/
  api.test.mjs
  mcp.test.mjs
  multiuser.spec.mjs
  visual.spec.mjs
```

## Package Scripts

Implement these commands exactly enough that the user has a simple operating
surface:

```json
{
  "scripts": {
    "seed": "node scripts/seed.mjs",
    "start": "node server/app.mjs",
    "dev": "node --watch server/app.mjs",
    "agent:once": "node scripts/agent-watch.mjs --once",
    "agent:watch": "node scripts/agent-watch.mjs",
    "dev:all": "concurrently -k -n app,agent \"npm start\" \"npm run agent:watch\"",
    "test": "node --test tests/*.test.mjs",
    "test:e2e": "playwright test tests/*.spec.mjs",
    "test:all": "npm test && npm run test:e2e"
  }
}
```

The default app URL is `http://127.0.0.1:4173`. Tests use another available
port, preferably `4174`. Honor `HOST` and `PORT`; setting `HOST=0.0.0.0` makes
the same process reachable by other machines on a LAN or through a simple HTTP
tunnel. Keep internal agent routes restricted to loopback request addresses even
when the public app listens on all interfaces.

## Data Store

`data/store.json` is the entire durable database. Load it into memory at server
startup. Serialize mutations through one in-process promise chain. Save by
writing a temporary file and renaming it over `store.json`.

The top-level shape is:

```json
{
  "schemaVersion": 1,
  "storeRevision": 0,
  "profiles": [],
  "sessions": [],
  "spaces": [],
  "results": [],
  "revisions": [],
  "draftFeedback": [],
  "edges": [],
  "reviews": [],
  "comments": [],
  "suggestions": [],
  "notifications": [],
  "activity": [],
  "workQueue": []
}
```

Use `crypto.randomUUID()` for IDs and ISO strings for timestamps.

### Core Records

`profiles`:

```text
id, displayName, normalizedName, pinSalt, pinHash, initials, color,
interestTags[], activeSpaceId, activeResultId, createdAt, lastSeenAt
```

`sessions`:

```text
id, profileId, tokenHash, createdAt, lastSeenAt
```

`spaces`:

```text
id, inviteSlug, name, description, createdAt
```

`results`:

```text
id, spaceId, title, statementLatex, hypothesesLatex[], proofMarkdown,
status, version, draftRevision, submittedRevisionId, lastCodexReviewAt,
lastCodexReviewContentLength, citation, bibtex, sourceType,
sourceSpaceId, sourceResultId, tags[], dependencyIds[], x, y, starredBy[],
createdBy, updatedBy, createdAt, updatedAt
```

Allowed result statuses:

```text
draft
pending_review
validated
rejected
imported
conflict_resolved
```

`edges`:

```text
id, spaceId, sourceResultId, targetResultId, relation,
createdBy, createdAt
```

Allowed edge relations:

```text
depends_on
supports
alternative
contributes_to
conflicts_with
```

`revisions` stores a complete result snapshot whenever a result is submitted,
validated, rejected, imported, or materially edited after validation.
Each revision includes `id`, `resultId`, `revisionNumber`, `reason`, `authorId`,
`status`, `snapshot`, and `createdAt`. The browser exposes this history as a
read-only timeline and can create a new draft from any snapshot.

`draftFeedback` stores pre-submission Codex coaching against an exact draft:

```text
id, resultId, draftRevision, status, summary, issues[], relevantResultIds[],
createdBy, createdAt
```

Each issue contains `severity`, `category`, `message`, optional `proofStep`, and
optional `suggestedText`. Feedback statuses are `current`, `stale`, and
`dismissed`. Feedback must never be displayed as current when its
`draftRevision` differs from the result's current revision.

`reviews`:

```text
id, resultId, reviewerType, reviewerId, decision, summary,
claimRestatement, assumptionChecks[], proofStepChecks[], dependencyChecks[],
counterexampleRisks[], issues[], confidence, createdAt
```

All review records in this POC are created by Codex. Comments provide the human
discussion workflow without adding a separate human-review state machine.

`suggestions`:

```text
id, spaceId, type, title, explanation, confidence,
sourceResultIds[], targetResultIds[], proposedChanges[], evidence[],
audienceUserIds[], status, createdBy, createdAt, actedBy, actedAt
```

Suggestion statuses are `open`, `accepted`, and `dismissed`.

Persist `dedupeKey = sourceResultId:targetResultId:type` on each suggestion.
Reject creation when the same key is already open or was dismissed in the last
24 hours. Targeted notifications use `suggestionId:userId:type` as their dedupe
key so repeated agent runs cannot notify the same user twice for one suggestion.

`notifications`:

```text
id, spaceId, userId|null, type, title, body, entityType,
entityId, createdBy, createdAt, readBy[]
```

`activity` is an append-only feed:

```text
id, spaceId, actorType, actorId, action, entityType, entityId,
summary, createdAt
```

### Work Queue

Every Codex-operated action begins as a queue record:

```text
id, type, priority, spaceId, entityType, entityId, targetRevision, payload,
status, attempts, claimedAt, leaseUntil, completedAt, error, createdAt
```

Allowed work types:

```text
validate_result
review_draft
suggest_integrations
```

Allowed work statuses:

```text
pending
claimed
completed
failed
```

Queue insertion rules:

- Saving a draft increments `draftRevision`. Run instant local structural checks
  in the browser, but do not queue Codex on every short pause.
- Queue `review_draft` after 12 seconds without edits only when at least 120
  non-whitespace characters changed since the last Codex review and no draft
  review completed in the last 60 seconds. `Review draft now` bypasses the idle
  and character thresholds but still deduplicates pending work.
- Submitting creates an immutable revision snapshot, stores its ID as
  `submittedRevisionId`, cancels pending draft-review work for that result, and
  inserts `validate_result` targeting that exact revision.
- Recording a validation decision of `validated` inserts
  `suggest_integrations`.
- Do not insert duplicates for the same pending work type and entity.

Draft work must be coalesced. If Codex returns feedback for an older revision,
store it as stale, do not show it as current, and leave or create work for the
latest revision. This makes pre-submission feedback genuinely usable while
preventing an agent run on every keystroke.

Queue priority is fixed:

```text
100  validate_result
70   suggest_integrations
30   review_draft requested explicitly
10   review_draft created by idle timer
```

`get_next_work` always returns the highest priority pending item, then the oldest
within that priority. A Codex run processes at most five items before exiting so
continuous drafting cannot create an unbounded run.

Claiming work creates a five-minute lease. Before every poll, the server returns
expired `claimed` items to `pending` and increments `attempts`. After three
failed or expired attempts, mark the item `failed` and notify the author that the
agent could not complete it.

While `validate_result` is pending or claimed, the submitted revision is frozen
and the editor is read-only. A `needs_changes` decision returns the result to
editable `draft` state. A rejected result stays read-only but offers `Create
revised draft`. A validated result is read-only until the author chooses `Create
new revision`; both commands clone a snapshot into a new editable draft while
preserving history.

## URL Join and Lightweight PIN Identity

There is no signup, email address, invitation approval, or password recovery.

Every theorem space has a shareable route:

```text
http://<host>:4173/join/<inviteSlug>
```

Opening it shows one compact join dialog with display name, short PIN/password,
and color. A new case-insensitive name creates a profile immediately. An existing
name requires the same PIN. Accept 4-12 characters so a numeric PIN or small
password works.

Hash the PIN with Node's built-in `crypto.scryptSync` and a per-user random salt.
On success, issue a random session token, store only its hash in `sessions`, and
return the raw token once. Keep the token in browser `localStorage`; send it as a
Bearer token to HTTP APIs and in the WebSocket connection query. Sessions do not
expire in this POC.

Anyone with the URL may create a name and PIN and join immediately. This is
lightweight identity, not serious security, but it prevents another casual user
from accidentally taking over an existing display name.

The profile dialog must have a seeded demo-name shortcut so end-to-end tests can
create users without typing through a complex onboarding flow.

## HTTP API

All public responses use JSON. Return `{ error: { code, message } }` with an
appropriate status on failure.

### Bootstrap and Spaces

```text
POST   /api/join
POST   /api/session/restore
GET    /api/bootstrap?spaceId=<id>
PATCH  /api/profiles/me
GET    /api/spaces
POST   /api/spaces
PATCH  /api/spaces/:id
```

`bootstrap` returns the selected space, all visible spaces, profiles, results,
edges, reviews, comments, current draft feedback, open suggestions,
notifications, and recent activity. Except for `/api/join`, require the session
token and derive the current profile from it instead of trusting `userId` input.

### Results and Graph

```text
POST   /api/results
PATCH  /api/results/:id
DELETE /api/results/:id
POST   /api/results/:id/request-draft-review
POST   /api/results/:id/submit
POST   /api/results/:id/star
GET    /api/results/:id/revisions
POST   /api/results/:id/revisions/:revisionId/clone
POST   /api/edges
DELETE /api/edges/:id
POST   /api/spaces/:id/layout
```

The layout endpoint runs Dagre server-side, persists positions, and broadcasts
the resulting result updates.

### Collaboration

```text
POST   /api/results/:id/comments
POST   /api/notifications/read
POST   /api/notifications/read-all
```

### Suggestions

```text
POST   /api/suggestions/:id/accept
POST   /api/suggestions/:id/dismiss
```

Accepting a suggestion applies its explicit `proposedChanges` transactionally
inside one store mutation. Supported changes are:

```text
create_imported_result
create_edge
```

Validate every referenced ID before applying anything. Acceptance appends an
activity event and a notification, then broadcasts all changed entities. It does
not queue an AI audit; deterministic projection checks run inside the mutation.

### Internal Agent API

Bind these endpoints to localhost only. The MCP server calls them; browsers do
not.

```text
GET    /api/internal/work/count
POST   /api/internal/work/next
GET    /api/internal/work/:id/context
GET    /api/internal/work/:id/research-context
POST   /api/internal/work/:id/draft-review
POST   /api/internal/work/:id/validation
POST   /api/internal/work/:id/integrations
POST   /api/internal/work/:id/fail
GET    /api/internal/spaces/:id/projection
```

## Realtime Protocol

Use one WebSocket endpoint:

```text
ws://127.0.0.1:4173/ws?spaceId=<spaceId>&token=<sessionToken>
```

Reject missing or invalid sessions. The `userId` is derived from the session
rather than trusted from browser input.

The server maintains in-memory presence by socket. Presence is not written on
every heartbeat.

Client-to-server messages:

```text
presence.update   { activeResultId, activity }
editing.acquire   { resultId }
editing.release   { resultId }
cursor.move       { x, y }
node.drag         { resultId, x, y }
ping              {}
```

Server-to-client messages:

```text
presence.sync     { users[] }
editing.sync      { locks[] }
cursor.move       { userId, x, y }
node.drag         { userId, resultId, x, y }
entity.upsert     { entityType, entity }
entity.delete     { entityType, id }
notification.new  { notification }
draft.feedback    { resultId, draftRevision, feedback }
queue.changed     { pendingCount }
agent.status      { state, currentWorkType, updatedAt }
toast             { tone, message }
```

Throttle cursor broadcasts in the browser to 15-20 Hz. Broadcast temporary node
positions while dragging, but save the durable position only when the pointer is
released through `PATCH /api/results/:id`.

On reconnect, call `bootstrap` again. Do not implement offline replay.

For targeted notifications, the server sends `notification.new` only to sockets
whose profile ID is in the notification audience. Bootstrap likewise returns
only global notifications and notifications addressed to the active profile.

Editing locks are soft, in-memory presence leases with a 30-second heartbeat.
Opening an editor acquires the result lock; closing it or disconnecting releases
the lock. Other users see the result read-only with the editor's name and a
`Take over editing` command. Taking over broadcasts the change and prevents
silent last-write-wins data loss without implementing CRDTs.

Every persisted mutation increments a global `storeRevision`, included in
bootstrap and WebSocket entity messages. Clients ignore messages older than the
latest applied revision and re-bootstrap after detecting a revision gap.

## MCP Server

Build `mcp/server.mjs` as a local stdio MCP server. It communicates with the app
through `MATHHIVE_URL`, defaulting to `http://127.0.0.1:4173`.

The MCP server initialization instructions must summarize the operator workflow
in the first 512 characters:

```text
Manually poll MathHive with get_next_work, inspect the claimed context, perform
draft coaching, proof review, or integration analysis, then push one atomic MCP
outcome containing every decision, notification, suggestion, and graph proposal
for the server to enact. Never claim formal proof. Process at most five items and
stop when no work remains.
```

Expose only these tools. Codex must call them itself; the watcher only wakes a
Codex run and never makes research decisions or writes POC outcomes.

### `get_next_work`

Atomically polls and claims the highest-priority pending item, creates its
five-minute lease, and returns the item plus current agent status. Returns
`empty: true` when no work remains. This is how Codex manually polls the server.

### `get_work_context`

Read-only. Inputs: `work_id`. Returns the claimed target revision, result,
incoming/outgoing edges, dependencies, Codex reviews, comments, citations,
current draft feedback, parsed proof steps, author, space summary, and structural
warnings. It refuses expired or unclaimed work.

### `search_research_context`

Read-only. Inputs: `work_id`, optional `tags`, `limit` capped at 200, and optional
`result_ids` capped at 10. Valid only for integration work. Without IDs it
returns compact validated/imported results, active pending drafts, authors,
interest tags, and active result IDs from other spaces. A follow-up call with
selected IDs returns their full statements, hypotheses, dependencies, citations,
and current proof summaries. No embeddings are needed at this scale.

### `submit_draft_review`

Inputs: `work_id`, `draft_revision`, `summary`, `issues`,
`relevant_result_ids`, and an author `notification` authored by Codex. In one
server mutation it stores current/stale feedback, creates the notification and
activity entry, completes the queue item, and broadcasts the outcome. The server
does not invent the feedback or notification; it enacts Codex's command.

### `submit_validation`

Inputs: `work_id`, `submitted_revision_id`, `decision`, `summary`,
`claim_restatement`, `assumption_checks`, `proof_step_checks`,
`dependency_checks`, `counterexample_risks`, `issues`, `confidence`, and an
author `notification` authored by Codex. In one server mutation it verifies the
lease/revision, stores the Codex review, changes status, snapshots history,
creates notification/activity, queues integration work when validated, completes
the item, and broadcasts all changes. Reject a nontrivial validation without
proof-step checks.

### `submit_integrations`

Inputs: `work_id`, `source_result_id`, zero to four structured suggestions, and
targeted `notifications[]` authored by Codex. Suggestions contain source/target
IDs, evidence, audience user IDs, and constrained proposed graph commands. In one
server mutation it validates IDs and dedupe keys, persists accepted new
suggestions and corresponding notifications/activity, completes the item, and
broadcasts only to affected users. The server does not choose relevance or write
notification prose; Codex manually pushes those decisions in this command.

### `inspect_projection`

Read-only. Inputs: `space_id`. Returns node/edge counts, statuses, positions,
open suggestions, unread notification counts, activity, presence, dangling
references, duplicate edges, disconnected nodes, overlaps, and off-canvas nodes.
Codex calls it after submitting integrations to confirm the intended graph state.

### `fail_work`

Inputs: `work_id`, `error`, and `retryable`. Retryable failures release the lease
and return to pending unless the attempt limit is reached. Terminal failures mark
the item failed and create the required author-facing failure notification.

Mark context/projection tools read-only. Outcome tools are atomic commands with
strict schemas. There is no runtime screenshot MCP tool, graph-repair tool, or
AI audit queue.

### Deterministic Runtime Projection Checks

The Node server, not Codex, performs cheap graph checks before every graph
mutation: referenced nodes exist, source differs from target, dedupe key is
unique, positions are finite and clamped to canvas bounds, and no unsupported
relation is used. Suggestion acceptance applies only prevalidated proposed
commands in one store mutation. UI appearance is verified by Playwright during
implementation and tests, not by a browser running inside the production MCP
loop.

## Project Codex Configuration

Create `.codex/config.toml`:

```toml
[mcp_servers.math_hive]
command = "node"
args = ["mcp/server.mjs"]
cwd = "."
required = true
startup_timeout_sec = 15
tool_timeout_sec = 90
default_tools_approval_mode = "auto"
```

Project-scoped MCP configuration and local stdio server commands are supported
Codex behavior. Official references:

- https://learn.chatgpt.com/docs/extend/mcp
- https://learn.chatgpt.com/docs/config-file/config-reference

## Durable Codex Operator Instructions

Create a short root `AGENTS.md`. It should contain both repository commands and
the runtime operator rules because Codex reads project `AGENTS.md` before each
run.

Required content:

```markdown
# MathHive Agent Instructions

## Build contract
- Implement and preserve every acceptance criterion in AGENTIC_MVP_PLAN.md.
- Keep the existing MathHive visual design and use the current CSS before adding
  new visual patterns.
- Run npm run test:all after behavioral changes.

## MCP operator contract
- For runtime queue work, use only the math_hive MCP tools for application data.
- Manually call get_next_work, inspect its context, decide, and submit one atomic
  outcome command containing the review/suggestions and required notification text.
- Review the latest saved draft after an editing pause and never present feedback
  for an older revision as current.
- A Codex validation is an advisory mathematical/workflow review, not formal proof.
- For submitted proofs, restate the claim and examine assumptions, each proof
  step, dependencies, notation, and plausible counterexamples before deciding.
- Never invent a citation or silently mutate a mathematical claim.
- Generate at most four specific integration suggestions, each tied to existing
  result IDs, targeted to relevant users, and represented as explicit proposed
  graph changes.
- After submitting integrations, inspect the workspace projection and report any
  deterministic server warnings in the outcome summary.
- Process at most five items per run and stop when get_next_work returns empty.
```

Official AGENTS guidance:
https://learn.chatgpt.com/docs/agent-configuration/agents-md

## Codex Runtime Operator Prompt

Create `prompts/operator.md`:

```markdown
Act as the MathHive research integration operator. Use the math_hive MCP server.
Process at most five work items. For each item, call get_next_work yourself; the
server chooses the highest priority and atomically claims it. Stop when it returns
empty.

For review_draft:
1. Retrieve the claimed work context and exact draft revision.
2. Read the rendered claim, hypotheses, proof steps, dependencies, and citations.
3. Produce concise coaching on missing assumptions, unclear or invalid steps,
   notation inconsistencies, likely duplicates, and relevant existing results.
4. Call submit_draft_review once with the exact revision, feedback, and a concise
   author notification. The server stores, notifies, and completes atomically.
5. If the server reports stale, do not overwrite the newer draft. Do not change
   validation status.

For validate_result:
1. Retrieve the claimed submitted-revision context.
2. Restate the claim and hypotheses in precise terms.
3. Check each proof step for whether it follows from the previous steps,
   hypotheses, or cited dependencies. Check notation consistency, dependency
   direction, edge cases, plausible counterexamples, duplicates, and citations.
4. Prepare exactly one decision with structured assumption, step, dependency,
   and counterexample checks plus an advisory confidence. Do not claim formal
   proof or claim to have verified external sources not included in context.
5. If any essential step is omitted or circular, use needs_changes or rejected,
   not validated.
6. Call submit_validation once with the full review and an author notification
   explaining the decision and next action. The server enacts all changes
   atomically.

For suggest_integrations:
1. Retrieve the claimed validated-result context.
2. Search research context from other spaces, including validated work and active
   drafts currently being edited by other users.
3. Compare claims, assumptions, tags, dependencies, citations, and user interests.
4. Prepare zero to four specific suggestions. Every suggestion must identify
   existing source/target IDs, relevant audience user IDs, and explicit graph
   changes.
5. Write separate targeted notification text for the source author and affected
   users, explaining why the work relates to their active result. Do not send a
   global broadcast.
6. Call submit_integrations once with suggestions and notifications. Then call
   inspect_projection to confirm the intended collective graph state.

Never edit repository files during this operator run. Never use shell or direct
HTTP calls for application data. All POC outcomes must be manually authored and
pushed through the math_hive MCP outcome commands.
```

## Agent Watcher

`scripts/agent-watch.mjs` makes Codex polling explicit and reliable instead of
assuming an interactive thread will remain alive forever.

The watcher uses the internal count endpoint only as a cheap wake-up gate so an
idle system does not continuously spend Codex turns. After wake-up, Codex itself
polls and reads queue work through MCP, and every application mutation it makes
goes through MCP.

Behavior:

1. On startup verify the app health endpoint and `codex --version`; report
   `agent.status: offline` instead of crashing when either is unavailable.
2. Poll `GET /api/internal/work/count` every three seconds. This endpoint also
   reaps expired leases before returning the count.
3. If work exists and no Codex child is active, spawn one ephemeral run.
4. Invoke Codex from the repository root with:

```text
codex exec --ephemeral --sandbox read-only --skip-git-repo-check <operator prompt>
```

5. Load the prompt text from `prompts/operator.md` and pass it as the single task
   argument. Do not use the deprecated `--full-auto` flag.
6. Stream child output with an `[agent]` prefix.
7. Broadcast agent online, busy, idle, and failed states through the app's
   internal API so the UI assistant header reflects reality.
8. After success, poll the count immediately. After failure, mark the agent
   failed and wait ten seconds; claimed work is recovered by lease expiry.
9. `--once` processes one bounded non-interactive Codex run and exits.

`codex exec` is intended for pipelines and scheduled jobs, supports explicit
sandbox settings, and reuses saved CLI authentication. Official reference:
https://learn.chatgpt.com/docs/non-interactive-mode

## Validation Semantics

Codex validation is not formal mathematical proof. The UI must label it
`Codex reviewed` and expose the review summary and checks.

The intended POC behavior is a manual model review of whether the supplied proof
makes sense. Codex must inspect the proof rather than only checking that fields
are populated. It must produce a visible review containing:

- a precise restatement of the claim and hypotheses;
- one verdict and reason for each parsed proof paragraph or numbered step;
- checks that every cited dependency exists and is used in the claimed direction;
- notation and quantifier consistency checks;
- circular-reasoning or missing-lemma findings;
- plausible edge cases or counterexample risks;
- a final advisory decision and confidence.

Parse proof Markdown into stable paragraph/step IDs before sending context through
MCP so returned checks can be displayed beside the corresponding source section.

Codex may mark a result `validated` when all of these are true:

- the LaTeX claim, hypotheses, and proof are present where required;
- the proof has enough detail to assess the stated claim step by step;
- referenced dependencies exist and do not obviously contradict the claim;
- citations are either present or explicitly marked as original work;
- there is no exact or near-exact duplicate in the current space;
- no obvious mathematical inconsistency is detected in the supplied context.

A result with any unresolved `error`-severity current draft feedback cannot be
validated without Codex explicitly explaining why the issue is no longer
applicable in the submitted revision.

Use `needs_changes` when the idea may be sound but context is incomplete. Map it
back to editable result status `draft`. Use `rejected` only for a clear conflict,
unsupported claim, or malformed submission.

The confidence field is an advisory score for UI ordering, not a calibrated
probability.

Codex validates only the supplied statement, proof, dependency statements, and
included context. A citation alone is treated as an asserted dependency; Codex
must not claim it checked the cited paper. If the proof depends on an unstated
external theorem, the practical POC decision is `needs_changes` with a request
to add the theorem statement or a graph dependency.

## UI Wiring

Preserve the current layout and connect each existing surface to server state.

### Join Experience

- The share URL opens directly to the name, PIN/password, and color dialog.
- The dialog creates a new profile or resumes an existing name with the matching
  PIN in one action.
- There is no email, confirmation flow, or administrator approval.
- After joining, preserve the current invite slug in the URL so it can be copied
  directly to another mathematician.
- Show clear inline errors for an incorrect PIN or already-used name.
- Restore a valid local session without showing the dialog again.

### Mathematical Authoring

The result editor is a split source-and-preview workspace designed for
mathematicians, not a generic single-line form.

Required authoring fields:

- title;
- theorem/claim in LaTeX;
- zero or more hypotheses/assumptions in LaTeX;
- proof in Markdown supporting inline `$...$` and display `$$...$$` LaTeX;
- tags;
- dependencies selected from existing graph results;
- citation text and optional BibTeX;
- source type and optional original-work checkbox.

Required editor behavior:

- live KaTeX rendering for the statement and hypotheses;
- live rendered Markdown/LaTeX proof preview;
- visible source/preview segmented control on mobile and split view on desktop;
- a compact math insertion bar for common constructs such as `\\forall`,
  `\\exists`, `\\Rightarrow`, `\\in`, `\\leq`, `\\geq`, `\\lambda`,
  `\\sum`, `\\frac{}{}`, and display-math blocks;
- preserve cursor selection when inserting a construct;
- autosave after 750 ms idle and show `Saving`, `Saved`, or `Offline`;
- run immediate local structural checks for unbalanced math delimiters, invalid
  KaTeX, missing statement/proof, empty hypotheses references, and missing
  dependency IDs;
- schedule Codex draft review after 12 seconds without edits only when the
  content-delta and cooldown queue rules are satisfied;
- show `Codex checking revision N` while review work is active;
- render current feedback beside the proof with severity and optional proof-step
  reference;
- mark feedback stale immediately after the next edit;
- allow `Review draft now` without submitting;
- keep `Submit for validation` as a separate explicit command.

This is the required pre-submission suggestion experience. It is near-realtime
after an editing pause, not token-by-token autocomplete. Codex startup and proof
reasoning may take several seconds, but feedback must arrive through WebSocket
without a page refresh and must always identify the reviewed revision.

### Left Sidebar

- Render spaces and counts from `bootstrap`.
- Workspace switching fetches the next space and reconnects the WebSocket.
- Render realtime collaborators from presence instead of seed-only people.
- Keep seeded offline collaborators so the demo still feels populated, but mark
  them offline and never count them as live.
- Remove archived-space management from the POC; show only active theorem spaces.

### Graph Canvas

- Replace static node and edge arrays with current state.
- Keep the current DOM/SVG renderer and drag behavior.
- Render LaTeX through KaTeX with safe error fallback to plain text.
- Single click selects a result.
- Double click opens the result inspector/editor.
- Add a small `New result` command to the graph toolbar.
- Add a link mode: select a source, select a target, choose the relation, save an
  edge.
- Node drag previews over WebSocket and persists on release.
- Dependency layout calls the server layout endpoint.
- Filters remain client-side.
- Minimap reflects actual node positions.
- Keep only graph mode. Remove the decorative grid, list, code, and metrics view
  controls instead of implementing alternate renderers.

### Result Inspector

Implement one modal or right-side inspector, not multiple new page layouts. It
must support:

- title, LaTeX statement/hypotheses, Markdown/LaTeX proof, tags, citation, and
  BibTeX;
- structured hypotheses, dependency selector, proof preview, and current draft
  feedback;
- create and edit;
- comments;
- Codex review history;
- revision history showing author, timestamp, status, and a read-only snapshot;
- `Create new draft from revision` without building a line-diff engine;
- submit for Codex review;
- delete draft;
- show source space/result for imports.

Stars remain functional and per profile. A star toggles membership in
`starredBy`, appears on the graph card immediately for that user, and supports a
`Starred` filter. It does not create notifications or queue Codex work.

### AI Assistant

- Read open suggestions from server state.
- While the editor is open, show a `Draft Coach` view containing only feedback
  for the current result and exact draft revision.
- Keep cross-result and cross-space recommendations in the existing
  `Integration Assistant` view.
- Show the actual agent state: offline, idle, reviewing, integrating, or failed.
- `Refresh` queues `suggest_integrations` for each validated result in the active
  space that has no pending integration work.
- `Inspect` selects and opens the affected result(s).
- `Accept` calls the suggestion acceptance endpoint.
- `Dismiss` replaces the current decorative overflow action.
- `Cite` copies stored BibTeX or a readable citation.
- Accepted suggestions disappear from the open list and immediately update the
  graph for every connected user.

### Notifications and Activity

- Render persisted notifications and realtime inserts.
- Unread state is per browser profile using `readBy`.
- Deliver draft feedback and validation notifications to the author.
- Deliver relevance notifications only to `audienceUserIds`, including offline
  users when they next join.
- A relevance notification names the validated source result, the recipient's
  target result, and the reason Codex believes they connect.
- Mark one or all as read.
- `View all activity` opens a simple modal containing the append-only activity
  feed.
- Clicking a notification selects its entity when possible.

### Realtime Cursors

- Use actual profile name and color.
- Transform viewport coordinates into graph coordinates before broadcasting.
- Remove cursor and presence immediately when a socket closes.
- Do not persist cursors.

### Mobile

- Retain the existing mobile assistant drawer.
- Result inspector becomes a full-height sheet.
- Hide realtime cursors below 680px to prevent clutter.
- Ensure all graph and assistant controls remain reachable without overlapping
  the bottom toolbar.

## One-Burst Implementation Sequence

The implementing Codex agent must execute all phases in one run. It must not stop
after scaffolding, produce a partial backend, or ask for architecture choices
already resolved in this plan.

### Phase 0: Baseline and Scaffold

1. Read the current HTML, CSS, and JavaScript completely.
2. Capture the existing desktop and mobile screenshots as visual baselines.
3. Create `package.json` and install all dependencies in one `npm install`.
4. Move static UI files into `public/` and confirm the server serves an unchanged
   visual baseline.

Gate: the current mockup loads from the Node server before data wiring begins.

### Phase 1: Store, Seed, and API

1. Extract all current seed arrays into `data/seed.json`.
2. Implement the in-memory JSON store and serialized persistence.
3. Implement lightweight name/PIN sessions, model validators, and typed errors.
4. Implement public routes and internal agent routes.
5. Add store/API tests before touching realtime behavior.

Gate: join/resume, seed, bootstrap, CRUD, autosave/revision, submit, layout,
comments, notifications, and suggestion acceptance pass server tests.

### Phase 2: Realtime Multiuser Core

1. Implement WebSocket presence and broadcasts.
2. Add the browser API and realtime modules.
3. Replace hard-coded state with bootstrap state while preserving current render
   functions and CSS classes.
4. Wire node dragging, workspace switching, cursors, collaborator activities,
   and entity updates.

Gate: two browser contexts see each other, cursor motion, a dragged node, and a
created result without reloading.

### Phase 3: Full Browser Feature Coverage

1. Add the split Markdown/LaTeX result inspector/editor and live preview.
2. Wire comments, revision history, Codex reviews, citations, stars, filters, and
   layout. Remove archive, obsolete, human-review, and alternate-view controls.
3. Wire draft review states, revision-aware feedback, notifications, activity,
   and AI suggestion actions.
4. Implement imports and proposed graph changes.
5. Add loading, empty, offline, agent-busy, and failure states.

Gate: every control visible in the current mockup either performs its named
action or is intentionally removed. No decorative dead buttons remain.

### Phase 4: MCP and Codex Orchestration

1. Implement the internal agent API, coalesced draft-review timers, and queue
   triggers.
2. Implement every MCP tool and server instructions.
3. Add project `.codex/config.toml`, `AGENTS.md`, and operator prompt.
4. Implement `agent-watch.mjs` and agent status broadcasting.
5. Add MCP protocol tests that launch the stdio server and call read and write
   tools against a test app.
6. Run one real `npm run agent:once` against seeded queue work.

Gate: an unsubmitted draft receives revision-matched Codex feedback, a submitted
result receives a step-by-step Codex review, the author receives Codex-created
notifications, validated work produces targeted integration suggestions for
another user's active work, and both browsers update in realtime.

### Phase 5: Visual and End-to-End Verification

1. Run two-context Playwright tests.
2. Run the complete validation -> suggestion -> acceptance -> deterministic
   projection-check flow.
3. Capture desktop at 1536x1024 and mobile at 390x844.
4. Inspect screenshots for blank canvas, clipping, overlaps, inaccessible
   controls, and graph framing.
5. Fix every observed problem, rerun tests, and leave `npm run dev:all` running.

Gate: `npm run test:all` passes, the true Codex MCP flow passes, screenshots are
visually coherent, and the final response gives the local URL and run commands.

## Required End-to-End Scenarios

### Scenario 0: URL Join

1. Alice opens `/join/spectral-gap`, enters a new name and short PIN, and joins
   immediately.
2. Bob opens the same URL on another machine/context and does the same.
3. Reload restores both sessions without another join dialog.
4. A third context cannot reuse Alice's name with the wrong PIN.

### Scenario 1: Realtime Collaboration

1. Open Alice and Bob in separate browser contexts.
2. Join the same space.
3. Both collaborator panels show two online users.
4. Alice moves her cursor; Bob sees it.
5. Alice drags a node; Bob sees the preview and final persisted position.
6. Alice opens the result editor; Bob sees Alice's soft lock and a read-only
   result instead of silently overwriting it.
7. Bob comments on the node; Alice sees the comment and activity event.

### Scenario 2: Codex Validation

1. Alice writes a claim, hypotheses, and proof using Markdown and LaTeX.
2. The live preview renders the mathematics before submission.
3. Autosave creates a new draft revision; Alice clicks `Review draft now` so the
   deterministic test does not wait for the idle/cooldown timer.
4. Codex polls `review_draft` through MCP and records revision-matched feedback.
5. Alice sees feedback without refreshing and can edit in response.
6. Old feedback becomes stale after the edit; new feedback targets the latest
   revision.
7. Alice submits the complete result.
8. The result becomes `pending_review` and the assistant shows `reviewing`.
9. Codex checks assumptions, every proof step, dependencies, notation, and
   counterexample risks through MCP.
10. Codex records a validation and creates a targeted author notification.
11. Both browsers see the new status, Codex review, and activity; Alice receives
    the notification.

### Scenario 3: Collective Integration

1. A validated result exists in another theorem space.
2. Bob is actively editing a related draft in the current space.
3. Codex processes `suggest_integrations` through MCP and sees both records plus
   Bob's active-work context.
4. Bob receives a targeted notification explaining why the validated result is
   relevant to his draft.
5. The assistant shows a concrete cross-space suggestion with evidence.
6. Bob accepts it.
7. The imported node or dependency edge appears for both users.
8. Codex inspects the projection after pushing integrations; Playwright confirms
   the updated graph remains visually coherent.

### Scenario 4: Notifications

1. Validation, suggestion, comment, and acceptance each create notifications.
2. The bell count is derived from the active profile's unread records.
3. Mark-one and mark-all update immediately.
4. Selecting a notification focuses the associated graph entity.

### Scenario 5: Responsive UI

1. Desktop retains the generated mockup's three-column composition.
2. Mobile retains a usable graph and opens the AI assistant as a drawer.
3. The result inspector is usable at both sizes.
4. No text or control overlaps at either acceptance viewport.

## Test Matrix

`api.test.mjs`:

- creates a profile with name/PIN, resumes it, and rejects a wrong PIN;
- authorizes HTTP and WebSocket requests with the issued session;
- bootstraps seed data;
- creates and edits a result;
- increments draft revisions and coalesces draft-review queue work;
- prioritizes submitted validation over draft coaching;
- requeues expired claims and fails work after the attempt limit;
- freezes submitted revisions and cancels pending draft work;
- rejects current feedback for stale revisions;
- snapshots revisions;
- lists revision history and creates a new draft from a prior snapshot;
- toggles per-profile stars without queuing Codex work;
- submits and deduplicates queue work;
- creates/deletes edges;
- runs layout;
- accepts a suggestion atomically;
- reads notifications;
- persists and reloads the JSON store.

`mcp.test.mjs`:

- launches a test app;
- launches the stdio MCP server;
- atomically polls and claims highest-priority work;
- retrieves full result context;
- submits current/stale draft outcomes atomically with notification/activity;
- submits validation outcomes atomically with notification/activity;
- rejects a nontrivial validation without proof-step checks;
- submits targeted integration suggestions and notifications atomically;
- deduplicates suggestions and targeted notifications;
- inspects projection;
- verifies every mutation through the public bootstrap endpoint.

`multiuser.spec.mjs`:

- tests two profiles and presence;
- tests join, session restore, and wrong-PIN rejection;
- tests cursor and node drag propagation;
- tests soft editing locks and explicit takeover;
- tests result/comment realtime propagation;
- tests autosave and revision-matched draft feedback propagation;
- tests stale feedback disappearing after an edit;
- tests per-profile stars and revision-history navigation;
- tests notification and suggestion acceptance propagation;
- tests that a relevant second user receives a targeted notification while an
  unrelated third user does not;
- reloads to prove persistence.

`visual.spec.mjs`:

- desktop screenshot;
- mobile graph screenshot;
- mobile assistant-open screenshot;
- desktop math editor with source, rendered proof, and draft feedback;
- mobile math editor source/preview modes;
- no browser console errors;
- ten or more visible seeded result nodes on desktop;
- all panels remain within viewport bounds;
- canvas contains non-background pixels and visible SVG edges.

## Explicit Shortcuts

These are accepted MVP constraints and should not be "fixed" during the burst:

- No serious authentication, permissions, invitations, recovery, or private
  spaces; only name plus short PIN and a persistent session token.
- No database server; one JSON file is the durable store.
- No horizontal scaling or multi-process writes.
- No CRDT; one soft presence lock protects each actively edited result, with an
  explicit takeover action.
- No offline edit queue.
- No vector database; Codex reads up to 200 validated result summaries.
- No direct OpenAI API integration in the app; Codex CLI is the AI runtime.
- No email, browser push, or mobile push notifications.
- No formal theorem proving. Codex validation is advisory and labeled as such.
- No generic workflow engine; the three queue work types are hard-coded.
- No arbitrary AI database writes; MCP tools expose constrained mutations.
- No complex rich-text editor; Markdown textarea plus preview is enough.
- No per-keystroke AI completion; draft coaching runs after a short editing pause
  and arrives in realtime when Codex completes it.
- No arbitrary graph layout choices; dependency layout plus manual positions is
  enough.
- No runtime browser or screenshot inside the MCP loop; deterministic projection
  checks run on the server and Playwright verifies visuals during tests.
- No archived-space management, obsolete-result workflow, human-review workflow,
  or alternate graph view modes.
- No service manager. `npm run dev:all` owns the local demo lifecycle.

## Fallback Rules for the Implementing Agent

- If the current static server occupies port 4173, stop only that known server or
  use 4174 temporarily; do not kill unrelated processes.
- If Playwright Chromium is missing, install it and continue.
- If the real Codex operator cannot run because CLI authentication is absent,
  finish and test the MCP server fully, then report that single external blocker.
  Do not replace Codex with fake validation data.
- If moving the existing UI files causes visual regressions, restore visual
  equivalence before continuing. Do not discard the current CSS.
- If a non-critical feature threatens completion, implement the smallest working
  modal or list interaction rather than removing the feature.
- Do not add Supabase, React, Next.js, Redis, Docker, queues, or cloud deployment
  during this burst.

## Definition of Done

The burst is complete only when all of the following are true:

- `npm install` followed by `npm run seed` works on a clean checkout.
- `npm run dev:all` starts the web app and Codex queue watcher.
- Two browsers collaborate in realtime.
- Users can join from the shared URL using only name and short PIN, and the same
  credentials restore the same lightweight identity.
- All persistent state survives a server restart.
- Every main control from the mockup is functional.
- The math editor supports LaTeX claims/hypotheses, Markdown plus LaTeX proofs,
  dependencies, citations, autosave, and live rendered preview.
- Stars are per profile, and revision history exposes immutable snapshots plus
  `Create new draft from revision`.
- An unsubmitted draft receives current-revision Codex feedback through MCP and
  stale feedback is never presented as current.
- A browser submission creates real MCP-visible queue work.
- Codex can poll/claim work, inspect context, and manually push atomic draft,
  validation, notification, relevance, and graph-proposal outcomes through MCP.
- A user whose active work is relevant to a newly validated result receives a
  targeted explanation and integration suggestion; unrelated users do not.
- Suggestion acceptance changes the graph for all connected users.
- Notifications and activity accurately reflect human and Codex actions.
- Desktop and mobile screenshots closely retain the current visual design.
- Automated API, MCP, multiuser, and visual tests pass.
- No console errors occur in the tested user flows.
- The final implementation response includes the app URL, commands, test results,
  and the precise distinction between Codex review and formal proof.

## Copy-Paste Implementation Directive

Use this when starting the implementation run:

```text
Implement AGENTIC_MVP_PLAN.md completely in one sustained agentic burst. Preserve
the existing MathHive visual design, make every visible workflow real, and use
the exact single-process JSON/WebSocket plus Codex-MCP architecture in the plan.
Do not stop at scaffolding or a proposal. Install dependencies, implement all
phases, run the real MCP operator flow when authentication permits, test with two
browser contexts, verify URL plus name/PIN joining, exercise revision-aware
pre-submission math feedback and targeted cross-user relevance notifications,
inspect desktop and mobile screenshots, fix regressions, and leave the working
app running with its URL. Make reasonable local decisions without asking for
clarification unless an external credential is the only remaining blocker.
```
