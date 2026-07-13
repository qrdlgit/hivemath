# MathHive Product TODO

## Priority 1: Organize the Team

- [ ] **Roles and ownership:** Add per-space `Lead` and `Contributor` roles. The space creator starts as lead, and lead ownership can be transferred.
- [ ] **Research blueprint:** Let the lead record the team's agreed plan as clear official branches or tasks, with a short goal and priority for each.
- [ ] **Volunteering and assignment:** Let contributors volunteer for open tasks. Assignment begins only when the lead accepts a volunteer or a contributor accepts the lead's invitation.
- [ ] **Scoped proposals:** Let accepted participants create linked mathematical contributions and propose child tasks within their assigned branch; the lead decides whether proposed tasks join the official blueprint.
- [ ] **Simple task progress:** Use only `Open`, `Claimed`, `In progress`, `Blocked`, and `Done`.

## Priority 2: Connect Tasks to the Mathematics

- [ ] **Task-to-result links:** A task can point at the conjecture or subproblem being worked on and, when complete, link to the proof, result, computation, or counterexample it produced.
- [ ] **Root problem type:** Distinguish the theorem space's main open problem from conjectures, results, and proofs.
- [ ] **Clear graph relationships:** Add the most useful missing relationships, especially `special case of`, `refutes`, and `uses`, while keeping `supports` distinct from verified `proves`.
- [ ] **Codex completion flow:** When Codex validates a contribution and its graph relationship, update the affected task and conjecture, then notify the lead and relevant contributors.

## Priority 3: Keep Work Coordinated

- [ ] **Lead overview:** Show open and unclaimed tasks, volunteers awaiting a decision, active work, blockers, and newly validated results in one compact view.
- [ ] **Contributor focus:** Show each user their claimed work, nearby collaborators, and Codex suggestions relevant to that work.
- [ ] **Coordination notifications:** Notify users about volunteers, assignments, blockers, completed proofs, and newly relevant results without duplicating the activity feed.

## POC Success Path

A lead creates a branch and an open task; a contributor volunteers; the lead accepts; the contributor creates and submits a linked mathematical contribution; Codex validates the contribution and relationship; the task becomes done; the target conjecture and graph update in realtime; and affected users are notified.
