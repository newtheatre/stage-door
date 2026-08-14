# Roadmap & Revisit Notes

Future work agreed in principle but not yet scheduled. Each item states the problem, the sketched design, and what it touches — enough that a future session (human or Claude Code) can pick it up without re-deriving the thinking. When an item is picked up, it graduates: ADR for the decision, then specs into the main docs.

## R1 — Roles v2: configurable roles with expiry *(GRADUATED 2026-08-12 → [ADR-0011](decisions/0011-role-definitions-and-expiry.md))*

Built as sketched: `user_roles` expiry enforced at read time, `role_definitions` driving dropdown grants with committee-year defaults (31 July, `rolesConfig.ts`), 14-day expiry warnings + ITM digest, free-text grants surviving behind Advanced. Session contract unchanged. Note for R4's Workspace-Groups sync: expiry semantics now exist, as it wanted.

## R2 — MFA *(GRADUATED 2026-08-13 → [ADR-0012](decisions/0012-sso-only-workspace-and-mfa.md))*

Picked up as sketched, then reshaped by what production actually showed: nine of the ten privileged grants sat on password-only accounts, six of them `@newtheatre.org.uk` addresses that had never linked Google. So the first half of the work was **not MFA** — Workspace addresses now cannot use password login at all, inheriting Google's enforced 2SV, which covered most of the exposure for a fraction of the effort.

Differences from the sketch worth knowing: **both** factor types shipped, not passkeys-then-TOTP-later (a shared committee account can hand over a TOTP seed in the password manager but not a platform authenticator); TOTP is hand-rolled against the RFC 6238 vectors rather than taken as a dependency; there is no `users.mfa_required` column — the rule is derived (`:ADMIN` grant + password set), so it can never go stale against the roles table; and R4's "passkeys as a primary login method" arrived with it, since a passkey with user verification *is* a complete login.

## R3 — Account merge tool *(GRADUATED 2026-08-14 → [ADR-0015](decisions/0015-account-merge.md))*

Built as sketched: merge hook as the fourth required consumer-app hook (proscenium re-points four columns including the staff-attribution pair; rooms two), hooks-first ordering so a partial failure changes nothing central and the whole merge is re-runnable, role union with earliest-expiry-wins (a date beats permanent), credentials fill-only, loser erased via the ADR-0008 machinery, `legacy_ids` merge marker, dry-run report + typed confirmation in the admin UI. Second factors deliberately do not move. In time for the training system and fresher intake, as the sketch wanted.

## R4 — Candidate features *(gathered, not committed — review each year at handover)*

- ~~Passwordless login for ticket bookers~~ — **GRADUATED 2026-08-14 → [ADR-0013](decisions/0013-magic-links-and-the-mfa-seam.md)** as magic links (the emailed-OTP variant was considered and not built — the link wins on a population that opens the email on the same phone it signs in on). Shadow accounts included; MFA still gates enrolled accounts.
- **Role sync from Google Workspace Groups.** The theatre already administers committee membership as Workspace role groups (per the Workspace plan); a nightly job could map configured groups → role grants (e.g. members of `boxoffice@` get `proscenium:BOX_OFFICE` with end-of-year expiry), ending double administration. Needs a service account with Groups read scope and careful thought about which direction wins on conflict. Investigate after R1, since it wants expiry semantics to exist.
- **"Sign in with NNT" (OIDC provider mode).** Only if a third-party tool (forum, wiki, external ticketing) ever needs our accounts. Explicitly out of v1 (ADR-0001/0003); would be a significant addition — do not drift into it accidentally.
- **Sessions/devices UI ("log out that library computer").** Requires server-side session state, which ADR-0003 deliberately avoided. The epoch mechanism already gives "log out everywhere"; per-device management is the one thing it can't do. Revisit only if it becomes a real complaint.
- **New-login notification emails** ("new sign-in to your NNT account"). Cheap, but noisy for a population that logs in twice a year; if built, admins-only.
- **Booking-history claim nudge analytics** — measure how many shadow accounts convert after the confirmation-email nudge, and now how many use magic links (ADR-0013).

## Parking rules

Items live here until someone commits a phase to them. Adding an item: state problem + sketch + touches, keep it honest about cost. Removing an item: either it graduated (link the ADR) or record *why* it was dropped — future ITMs deserve the negative result too.
