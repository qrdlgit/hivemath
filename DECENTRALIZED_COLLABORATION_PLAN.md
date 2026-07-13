# MathHive Decentralized Collaboration Plan

## Outcome

Implement the product TODO as one complete collaboration loop for a small,
URL-invited team:

1. A lead creates or organizes a theorem space around a root problem.
2. The lead and contributors break the work into a visible research blueprint.
3. A contributor volunteers for a task and starts a linked mathematical draft.
4. Codex gives private draft feedback, then manually validates the submitted
   contribution and its proposed graph relationship through the standalone MCP.
5. The server updates the task, graph, target conjecture, activity, and relevant
   notifications in one realtime transaction.

The implementation should preserve the existing Node.js, JSON store, vanilla
JavaScript, WebSocket, and standalone MCP architecture.

### POC Speed Constraints

- Keep one JSON store and one application server; add no database or service.
- Extend `server/store.mjs`, the existing API, and current realtime events rather
  than introducing repositories, command buses, or a frontend framework.
- Use one-level task grouping, list ordering, and compact dialogs. Do not build a
  Kanban board, task graph, calendar, or drag-and-drop planner.
- Treat computations and exploratory notes as the existing general `Result`
  contribution. Add only `Counterexample` because it has distinct refutation
  validation behavior.
- Finish the complete two-user path before adding visual polish beyond the
  existing design system.

## Collaboration Principles

- **Lead means coordinator, not mathematical authority.** The lead curates the
  blueprint and resolves coordination conflicts, but cannot approve mathematics,
  overwrite authorship, or override Codex validation.
- **Participation is opt-in.** Contributors volunteer. A lead can invite someone
  to a task, but the user must accept before being shown as responsible for it.
- **Mathematical work is not gated by the blueprint.** Any contributor can create
  a conjecture, result, proof, computation, or counterexample at any time.
- **Authorship and history remain visible.** Reassignment never changes who wrote
  a result, and task/output changes are recorded in the activity feed.
- **Codex decisions are inspectable.** Validation and relevance suggestions show
  reasoning, evidence, confidence, and the exact revision reviewed.
- **AI review is always attributed.** The UI says `Codex reviewed` or
  `Codex-validated`, never an unattributed `verified`. A validated status is a POC
  review outcome, not a claim of community consensus or formal verification.
- **No productivity scoring.** Do not rank contributors, count output as status,
  or use stars as reputation. Stars remain personal bookmarks.
- **No silent coordination changes.** Lead transfer, task reassignment, reopening,
  and blocking produce a short visible activity entry and targeted notification.

## Intelligent Defaults

| Situation | Default behavior |
| --- | --- |
| New theorem space | The creator becomes its lead. If an existing seeded space has no lead, its first human member becomes lead. |
| Joining by URL | The user joins that space as a contributor using the existing name and short PIN flow. |
| Creating tasks | Any member may add a task. The lead controls ordering and grouping, not whether the idea is allowed to exist. |
| Task priority | `Normal`. Other choices are only `High` and `Exploratory`. |
| Volunteering | The first volunteer becomes the primary contributor immediately. Later volunteers join as collaborators. |
| Lead assignment | The UI says `Invite`, not `Assign`. An invitation may be accepted or declined without explanation. |
| Releasing work | A contributor can release a task at any time. The task returns to `Open` and keeps its history. |
| Inactivity | After seven days, show `No recent update`; never auto-unassign or shame the contributor. |
| Blocking work | `Blocked` requires a short reason so another mathematician can help. |
| Completing work | Verified `proves` or `refutes` work completes its matching task automatically. Exploratory work is completed manually by a participant or the lead. |
| Notifications | Notify only directly affected people. General events remain in the activity feed. |
| Lead transfer | The proposed new lead must accept. The current lead remains active until acceptance. |
| Codex disagreement | An author can revise and resubmit, or create a linked counterargument. The prior review stays in revision history. |

These defaults intentionally refine two items in `TODO.md`: direct assignment is
implemented as a declineable invitation, and volunteering does not wait for lead
approval. Those choices remove a central bottleneck while preserving lead
visibility and coordination controls.

## Data Model

Increment the JSON store schema and add migration defaults in
`MathHiveStore.#normalizeData()` so existing workspaces continue to load.

### Memberships

Add `memberships`:

```text
id, spaceId, profileId, role, joinedAt
```

`role` is only `lead` or `contributor`. Enforce exactly one lead membership per
space once that space has a human member. Add `pendingLeadProfileId` to `spaces`
for an accepted-transfer flow.

### Root Problem

Add `rootResultId` to `spaces`. Do not add a fourth mathematical contribution
type. Rootness is a role within the project, so an existing conjecture or result
can be designated as the root problem without changing its revision history or
validation semantics.

The lead may designate or replace the root. The root node receives a clear
`Root problem` marker. If its conjecture becomes proved or refuted, the theorem
space header reflects that state.

### Tasks

Add `tasks`:

```text
id, spaceId, title, goal, priority, status,
sortOrder, parentTaskId, targetResultId, expectedRelation, outputResultIds,
primaryContributorId, collaboratorIds, invitedProfileIds,
blockedReason, createdBy, updatedBy, completedBy,
createdAt, updatedAt, completedAt
```

Rules:

- Status is exactly `open`, `claimed`, `in_progress`, `blocked`, or `done`.
- Priority is exactly `high`, `normal`, or `exploratory`.
- `sortOrder` is a simple integer controlled by the lead; new tasks append.
- `parentTaskId` supports one practical level of branches and subtasks. Do not
  build a second dependency graph for tasks.
- `targetResultId` says which conjecture or result the task addresses.
- `expectedRelation` may be `proves`, `refutes`, `supports`, or null.
- `outputResultIds` links durable mathematical work to the task.
- Task records never appear as mathematical graph nodes.

### Result Authorship

Add `counterexample` to result `kind` and add `collaboratorIds` to results. A
counterexample uses the existing editor with labels focused on the construction,
hypothesis checks, and the exact conclusion it falsifies. General computations
remain `result` contributions.

The result creator controls the collaborator list. Result content may be edited
by its creator and explicit collaborators; the lead role does not grant edit
rights. Existing revision author IDs remain the audit trail.

When a participant uses `Start contribution` from a task, they become the result
creator and may add task collaborators as coauthors rather than doing so
automatically.

### Graph Relationships

Use one grammatical direction everywhere: the edge label must read naturally
as `source relationship target`.

- A proof **proves** a conjecture.
- Evidence **supports** a conjecture.
- A narrower claim is a **special case of** a broader claim.
- A counterexample **refutes** a conjecture.
- An argument **uses** a prior result.

Add `special_case_of`, `refutes`, and `uses`. Keep `supports`, `proves`,
`alternative`, and `conflicts_with`. Migrate old `depends_on` edges by reversing
them and changing the relation to `uses`, because the current direction is hard
to read consistently.

`proves` and `refutes` edges start as proposed and become verified only with a
validated source contribution. Other relationships are attributed assertions
and do not change result status by themselves.

## Permissions and Social Behavior

Keep the role matrix deliberately small:

| Action | Contributor | Lead |
| --- | --- | --- |
| Create mathematical work | Yes | Yes |
| Edit owned or coauthored work | Yes | Yes |
| Comment, star, and create relationships | Yes | Yes |
| Create a task or volunteer | Yes | Yes |
| Update a task they participate in | Yes | Yes |
| Organize blueprint order and branches | No | Yes |
| Invite or reassign with a visible reason | No | Yes |
| Rename the space or designate the root | No | Yes |
| Offer lead transfer | No | Yes |
| Validate mathematics | No | No; Codex reviews through MCP |

Lead reassignment is an exception for coordination recovery, not a normal path.
The normal action is a handoff invitation. Force-reopening requires a reason and
is available only for blocked work or work with no recent update; it notifies the
current participant and never modifies their results. Contributors may decline
invitations and release tasks freely.

## Server and Realtime Work

### API Surface

Add focused routes that map to user intentions:

```text
POST /api/spaces
POST /api/spaces/:spaceId/lead-transfer
POST /api/spaces/:spaceId/lead-transfer/respond
POST /api/spaces/:spaceId/root

POST /api/tasks
PATCH /api/tasks/:taskId
POST /api/tasks/:taskId/volunteer
POST /api/tasks/:taskId/release
POST /api/tasks/:taskId/invite
POST /api/tasks/:taskId/invitations/respond
POST /api/tasks/:taskId/outputs
```

`bootstrap` returns `memberships`, `tasks`, the current membership, and the
space lead. The public space list should show joined spaces; opening a valid
invite URL creates the missing contributor membership.

Every mutation runs through the existing serialized `mutate()` path and emits:

- an entity upsert or delete for realtime UI updates;
- one concise activity record;
- targeted notifications only when another person needs to act or know.

Add deterministic transition checks so two volunteers clicking at once cannot
both become the primary contributor. The later volunteer becomes a collaborator.

### Task State Transitions

```text
Open -> Claimed       first volunteer or accepted invitation
Claimed -> In progress first linked draft or explicit Start
In progress -> Blocked participant supplies a reason
Blocked -> In progress participant or lead records that work resumed
Any active -> Open    primary contributor releases, or lead reopens with reason
Any active -> Done    matching verified output, or explicit participant/lead action
Done -> Open          lead reopens with reason
```

Do not infer completion merely because a result was submitted. For a task with
an expected `proves` or `refutes` relationship, completion requires Codex to
validate the exact output revision and edge.

## User Interface

### Workspace Header and Membership

- Show a small `Lead` or `Contributor` badge in the profile menu.
- Add a compact space settings section for the lead: rename, choose root problem,
  invite lead transfer, and copy invite URL.
- Show the lead in the collaborator list without visually elevating their
  mathematical contributions.
- Add `New theorem space` to the space switcher. Creation asks only for a name
  and an optional initial root conjecture.
- Add `New counterexample` beside the existing result, conjecture, and proof
  commands; selecting a target proposes a `refutes` edge.

### Work Panel

Turn the existing right panel into three tabs: `Work`, `Codex`, and `Notices`.
Keep the graph as the main surface.

`Work` contains:

- `My work` first for every user;
- the space blueprint grouped by parent task;
- `Open`, `Blocked`, and `Done` filters;
- nearby collaborators whose active tasks target the same or directly connected
  mathematical nodes, without productivity or activity scoring;
- a compact lead summary for unclaimed work, invitations, blockers, and recent
  validated outputs;
- `Add task`, `Volunteer`, `Invite`, `Release`, `Block`, and `Start contribution`
  commands where relevant.

Use dense rows rather than graph rectangles or nested cards. Each row shows the
goal, target node, status, primary contributor, collaborator count, and recent
update. The lead summary is an alternate filter, not a managerial dashboard.

`Start contribution` opens the existing editor with the task, target result,
and expected relationship preselected. The result editor shows its linked task
and lets an author add coauthors.

### Graph

- Give the designated root node a stable visual marker and `Go to root` command.
- Keep tasks out of the graph; show a small task count or status indicator on a
  mathematical node when tasks target it.
- Expand the edge legend and editor relation menu with plain-language examples.
- Tooltips must read the complete relationship, such as `Proof A proves
  Conjecture B`, so arrow direction is never left to interpretation.
- Show proposed `proves` and `refutes` edges differently from verified edges.
- Label validated nodes and edges as `Codex-validated` in details and tooltips;
  reserve `formally verified` for an actual checked formal artifact.

### Notification Etiquette

Create notifications for:

- invitations, accepted invitations, and lead-transfer requests;
- another user volunteering for a task the lead created;
- blocking or releasing work that affects the lead or collaborators;
- validated task output and a proved or refuted target;
- a Codex relevance suggestion tied to the user's current task or draft.

Do not notify everyone about task creation, status edits, graph movement, stars,
or ordinary comments. Those belong in realtime state or the activity feed.

## Standalone MCP and Codex Orchestration

Keep `mcp/server.mjs` as a separate stdio MCP server and keep the polling worker.
Codex must continue to claim work, inspect frozen context, reason manually, and
push explicit commands back to the application.

### Context Changes

Extend `get_work_context` with:

- the linked task and expected relationship;
- the root problem and branch context;
- task participants and affected result authors;
- proposed `proves` or `refutes` edge state;
- the exact submitted revision and its authors.

Extend research-context search with active task targets so relevance is based on
what users are actually working on, not only broad tags or their last open node.

### Command Changes

- `submit_draft_review` reports whether the draft addresses its linked task and
  identifies potentially useful validated work before submission.
- `submit_validation` includes an explicit task outcome: `complete` or
  `keep_open`, with a rationale and task ID. The server checks this against the
  linked output, exact revision, and proposed edge before applying it.
- A validated `proves` edge marks the target conjecture `proved`; a validated
  `refutes` edge marks it `refuted`.
- Counterexample validation explicitly checks every target hypothesis, the
  constructed example, and the claimed failure of the target conclusion.
- `submit_integrations` accepts task IDs and sends targeted suggestions with a
  concise explanation of relevance and proposed graph changes.
- `inspect_projection` adds only necessary coordination checks: missing task
  targets, missing output results, invalid participant IDs, and verified edges
  whose target status was not updated.

Codex must not transfer roles, assign contributors, change task priority, or
silently create non-verified graph relationships. Integration changes remain
accept/dismiss suggestions unless they are the direct deterministic consequence
of an accepted validation command.

## Implementation Sequence

### 1. Schema and Migration

- Add memberships, task records, result collaborators, root designation, new
  relationships, and verification state.
- Backfill existing profiles as contributors in their active spaces.
- Make the first human joining an unowned seeded space its lead.
- Migrate `depends_on` edges to consistently directed `uses` edges.
- Update seed data with a root problem, lead, branches, open task, claimed task,
  blocked task, and linked completed task.

### 2. Store, API, and Realtime

- Implement role helpers, transition checks, routes, notifications, and activity.
- Enforce authorship/coauthor edit rules and lead-only organization actions.
- Include the new collections in bootstrap and realtime entity handling.
- Add unit/API tests before UI work.

### 3. Work and Membership UI

- Add space creation, role display, lead transfer, and root designation.
- Build the Work tab, task dialog, volunteer/invite/release/block flows, and lead
  overview using the current DOM and styling system.
- Add result coauthors and task linkage to the existing editor.
- Verify responsive layout before graph changes.

### 4. Graph Semantics

- Add root marking, task indicators, new relationships, verified edge states,
  directionally clear labels, filters, and migration-compatible rendering.
- Update Dagre layout inputs and projection checks for reversed `uses` edges.

### 5. MCP Completion and Relevance

- Extend MCP schemas, operator prompt, work context, validation transactions,
  task-aware relevance suggestions, and targeted notifications.
- Run the standalone poller against real queued proof, refutation, conjecture,
  draft-feedback, and integration work.

### 6. End-to-End Verification

- Run server/API tests and MCP contract tests.
- Use two isolated Playwright browser contexts for the complete success path.
- Verify desktop and mobile screenshots for the Work panel, graph, editor, and
  dialogs, including empty, blocked, invitation, and completed states.
- Confirm all meaningful changes appear in the second browser without reload.

## Acceptance Scenarios

1. A user creates a space and is shown as its lead; a URL joiner is a contributor.
2. A contributor creates a task without approval; the lead can place it in the
   blueprint without changing its author.
3. Two contributors volunteer simultaneously; one becomes primary and the other
   becomes a collaborator, with both clients updating in realtime.
4. A lead invites a contributor; declining creates no negative status or forced
   assignment.
5. A contributor starts a proof from a task, receives task-aware draft feedback,
   submits it, and keeps visible authorship and revision history.
6. Codex claims the work through the standalone MCP, validates the exact proof
   and `proves` edge, completes the task, marks the conjecture proved, and sends
   relevant notifications.
7. Codex validates a counterexample and `refutes` edge with the equivalent
   refuted-state behavior.
8. A blocked task requires a reason; release and lead reopening preserve history.
9. Lead transfer changes ownership only after the recipient accepts.
10. Stars remain personal, and neither stars nor activity produce rankings.

## Explicitly Out of Scope

- complex signup, organization administration, or production-grade security;
- voting, elections, reputation scores, contributor rankings, or governance;
- deadlines, time tracking, automatic reassignment, or workload optimization;
- archived-space management and obsolete-result workflows;
- a separate human-review queue or lead override of mathematical validation;
- multiple graph view modes or task nodes mixed into the theorem graph;
- large-scale concurrency, CRDT editing, or thousands-user scaling.
