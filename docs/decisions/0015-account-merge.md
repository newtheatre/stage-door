# ADR-0015: Account merge: the winner absorbs the loser, hooks first

**Status:** Accepted · **Date:** 2026-08-14 · **Deciders:** Matt Adcock (ITM 26/27) · Graduates roadmap R3 · Builds on [ADR-0008](0008-anonymise-not-delete.md)

## Context

People exist before their Workspace account does. The forcing case is the training system: a fresher's history lands on a personal-email account in week 2 of term; a Workspace account arrives months later, or never. The linking design (self-service Connect-Google, admin `pending_google_email`, email-match) prevents duplicates *when used*, but someone who signs in with Google before anyone links now has their history on account A and their session on account B. The merge tool is for exactly that: one person, two accounts, pick which survives.

## Decision

**An admin picks a winner and a loser; the winner absorbs everything; the loser is erased.** `POST /api/users/:id/merge` (`:id` = winner), driven from a Merge accounts card on the admin user page with a mandatory dry-run report and typed confirmation of the *loser's* email: the identity being destroyed is the one you must name.

**1. App hooks go first, and are the only step that can partially fail.** Each consumer app implements the fourth required hook, `POST /api/_hooks/auth/merge { fromUserId, toUserId, dryRun? }`, which re-points every user-referencing column onto the winner and deletes the losing mirror row (its unique email freed; proscenium's `restrict` FKs satisfied because nothing references it any more). Only when **every** hook succeeds does any auth-side state change. A failure returns `complete: false` with per-app results and changes nothing central: the admin re-runs once the app is back, and already-merged apps no-op because the hooks are idempotent. This is the same retry contract as erasure, and it means there is never a state where the central identity is gone but an app still points at it.

**2. Role union, least privilege.** Loser-only grants move with their provenance (`granted_by`/`granted_at`/`note`). Where both accounts hold the same role, the winner's row survives with the **earliest expiry** of the two, and a concrete date beats permanent (`NULL`): a merge must never extend anyone's access. A changed expiry clears `expiry_warned_at`, re-arming the 14-day warning. The union writes rows directly rather than through the ADR-0014-checked endpoint, deliberately: definition-less history (the dormant `ticketing:*` namespace) must move intact.

**3. Credentials fill gaps, never overwrite.** The winner keeps everything it has. Only what it *lacks* is taken from the loser: password, Google link (its unique freed by the erasure step), `verified` (a verified loser proves the person controls a mailbox), `lastLogin` (max), `createdAt` (min, membership started when the first account did). **Second factors never move**, a passkey or TOTP secret is bound to the account the person enrolled it against, and silently transplanting one is a security decision no admin should be making implicitly. The dry-run warns when the loser has factors; if the merged account needs MFA, the winner enrols afresh (ADR-0012's gate handles the gap).

**4. The loser is erased, not deleted**, `eraseUser(loserId, { via: 'merge' })`, the ADR-0008 machinery unchanged. This bumps the loser's epoch (sessions die), nulls its credentials (freeing the uniques the fill step needs), deletes its roles/tokens/factors, and calls the anonymise hooks, cheap no-ops, since the apps hold nothing of the loser's by then. Deleting the app-side mirror rows does **not** bend anonymise-never-delete: that rule protects the sales record, which now lives intact on the winner.

**5. The merge is a findable fact.** `legacy_ids` gains a third source, `'merge'`: the winner gets a row `{ source: 'merge', legacyId: <loserId> }` (idempotent via the `(source, legacy_id)` unique), so a merged-away id can always be traced forward. The audit log gets `user.merged` on the winner with the loser's **id only**: the loser's email must not outlive its own erasure in the audit trail. `retention_notices` for the loser are deleted (the `(user, stage)` unique forbids re-pointing; the winner's own retention clock stands).

## Alternatives considered

- **Re-point `users.id` itself (the cutover trick, `UPDATE users SET id = …` with deferred FKs)**: rejected: only works when the target row doesn't exist, and invariant 3 (canonical ids are stable forever) exists precisely to stop id rewrites becoming a habit.
- **Auth-side first, hooks after**: rejected: a hook failure would strand app rows pointing at an erased identity. Hooks-first means the worst outcome of any failure is "nothing happened yet".
- **Move second factors**: rejected, see §3.
- **Latest expiry wins on role conflicts**: rejected: a merge is an administrative convenience, not a grant. Anything it extended would bypass the expiry-warning machinery ADR-0011 built.
- **A merge-request flow for users**: rejected at this scale: merges are rare, need judgment about which identity survives, and the admin already verifies the person out of band.

## Consequences

Good: the training-system integration can rely on history following the person; duplicate cleanup is a two-minute admin task with a preview instead of a bespoke SQL script (the cutover's `rooms-fixes.sql` is now productised); every step is idempotent and auditable; consumer apps document one more hook (`docs/integrating-an-app.md`: merge is now the fourth required hook for new apps).

Bad: a merge is **destructive by design**: the loser's identity is gone, and un-merging means restoring from D1's weekly backup. Hence the typed confirmation of the loser's email, the dry-run-first UI, and the operations-runbook rule: *never merge two accounts that belong to two real people* (shared mailboxes happen; a merge is for one person's duplicates only). MFA enrolments do not survive a merge; a privileged winner may need to re-enrol.
