## Plan: Cross-Instance User Sync

Implement a manual, two-way, user-scoped sync flow between dev and production instances, initiated only from dev. The safest design is an allowlisted export/import pipeline: production only ever exports the selected user’s non-privileged data through a signed one-time token, and dev imports it into the email-matched dev user after applying conflict and filtering rules. The reverse direction should use the same pipeline and schema, but must still exclude secrets, admin-only records, and privilege-bearing account fields.

**Prompt**


I’m capturing this branch objective into the session plan first, then I’ll ask the minimum set of clarifying questions that affect the design boundary.


I have the objective and constraints recorded. The main unknowns are sync direction, conflict policy, and the exact data boundary, because those determine whether this stays safe on production.

Analyzing your answers...

>Q: Should sync be one-way from production to dev only, or also allow dev to push changes back to production?  
>A: two way sync - but syncs in either direction should be manual-only - not occuring on an automated schedule
  
> Q: What data should be in scope for the selected user?  
> A: All user-owned relational data - Everything tied to that user by FK or join tables, Workouts and plans only - Training/workout-related entities only, Nutrition and wellness too - Include nutrition, wellness, metrics, body measurements, Chat and AI history too - Include chat rooms, turns, usage, recommendations

> Q: How should sync be initiated?  
> A: On-demand self-service by the user - User initiates sync for their own account
   
> Q: How should the selected prod user map to dev?  
> A: Match by email - Simplest if accounts already correspond
  
> Q: Should production ever expose secrets or privileged records in the sync payload?  
> A: No, exclude secrets/admin-only data entirely - Recommended safety boundary
  
Your answers narrowed the shape considerably: **this is two-way, manual-only, scoped to one user’s non-privileged data, and keyed by email.**   

I still need the **conflict and operator model** nailed down before I can turn this into a sound implementation plan.


>Q: If the same record changed in both environments, what should happen on manual sync?  
>A: Newest updatedAt wins - Needs strong timestamp trust across both instances

>Q: How should deletions be handled?  
>A: Soft-delete only - Map deletions to tombstones where supported

>Q: Should binary/file data be included, such as FIT files or uploaded assets tied to the user?  
>A: Exclude blobs/files - Simpler and safer initial scope

>Q: When you say self-service, where should the user be allowed to start sync?  
>A: Only from dev instance - Prod remains passive/data source unless explicitly targeted

>Q: How should one instance authenticate to the other for sync?  
>A: Signed one-time user export/import token - Less persistent trust between instances

That resolves most of the risk surface. The remaining design gap is **how account identity and role-bearing fields behave, because syncing those naively would break your prod/dev permission boundary.**


>Q: Should account/profile rows sync only safe profile fields, while excluding roles, subscription, billing, tokens, and admin flags?  
>A: Yes, profile-only subset for account-like tables - Recommended to preserve the prod/dev privilege boundary

>Q: If the email does not exist on dev yet, what should happen?  
>A: Fail and require a pre-created dev account - Simpler but more manual



**Steps**

1. Define the sync boundary and data contract.  
   Depends on product decisions already made.  
   Create an explicit entity allowlist covering user-owned relational data to include: workouts/plans, nutrition/wellness, chat/AI history, goals/events, recommendations, and other user-scoped records.  
   Create an explicit denylist for privileged or environment-specific data: admin flags, billing/subscription state, secrets, OAuth/integration/API tokens, blobs/files, webhook secrets, and operational/admin tables.  
   Define per-table ownership rules so every exported row is provably reachable from the selected user or from an already-allowed child record.  
   Define field-level filtering for account-like tables so only safe profile fields sync, never role/privilege or environment-coupled identity/security fields.  
2. Design the sync protocol and trust model.  
   Depends on 1.  
   Use a signed one-time export/import token rather than persistent cross-instance trust.  
   Dev initiates the request, generates a sync request, and sends the user to production to authorize export of their own data.    
   Production validates the logged-in regular user, ensures the requested email matches the authenticated user, builds a filtered export package, signs it, and returns it only for that user.  
   Dev verifies the token/package signature, checks the target dev account by email, and fails if no matching dev user exists.  
3. Define merge and deletion semantics.
   Depends on 1.  
   Apply newest `updatedAt` wins where both sides have the same logical row.  
   Support manual sync in either direction using the same merge rules.  
   Do not hard-delete on sync; only propagate soft-delete semantics where the target schema supports them.  
   For tables without reliable `updatedAt`, decide deterministic fallback behavior before implementation, likely source-wins per sync direction or exclusion from v1.  
4. Map the implementation onto existing server patterns.  
   Depends on 2 and 3.  
   Reuse existing auth/session helpers to distinguish regular-user production access from dev-admin capabilities.  
   Reuse repository-style user scoping patterns so all data queries remain constrained by `userId` ownership.  
   Reuse audit logging for every sync request, approval, export, import, conflict decision, and failure.  
   Reuse existing admin user page and/or developer settings UX as the entry point on dev.  
5. Add a production-side export path.  
   Depends on 1, 2, and 4.  
   Add a user-authenticated route on production that accepts a one-time sync request, validates ownership, builds the export graph from allowlisted entities, strips denied fields, and emits a signed payload.  
   Ensure production never exposes data for other users and never exposes admin-only or secret-bearing records.  
   Ensure the payload includes stable identifiers, timestamps, source instance metadata, and a schema version for compatibility.  
6. Add a dev-side import/orchestration path.  
   Depends on 1, 2, 3, 4, and 5.  
   Add a dev-only initiation flow that starts sync for a selected target user from the dev instance.  
   Verify the returned signed payload, match the dev user by email, reject missing dev users, and apply upsert/merge logic across the allowlisted entities in dependency order.  
   Handle parent-child ordering and join tables explicitly, including self-references and many-to-many tables.  
   Produce a preview/summary of rows created, updated, skipped, conflicted, and soft-deleted.  
7. Add reverse-direction support from dev to production with the same safety boundary.  
   Depends on 5 and 6.  
   Keep initiation on dev, but require the production-side import path to enforce the same restriction: the production user can only sync their own non-privileged data.  
   Reuse the same schema versioning, filtering, validation, and audit model.  
   Treat production as the stricter environment: even when importing from dev, disallow role/privilege changes and any data outside the selected production user scope.  
8. Add admin/operator UX and observability.  
   Parallel with 5-7 after the protocol is defined.  
   Add a dev admin page or action on the existing admin user detail screen for initiating sync, showing direction, recent status, and dry-run/apply results.  
   Add production-facing user approval UX only if the one-time token flow requires an interactive confirmation page.  
   Add audit log metadata and, if useful, a dedicated sync history record for traceability and debugging.  
9. Verify with focused end-to-end scenarios.  
   Depends on 5-8.  
   Test prod-to-dev and dev-to-prod manual sync for a single existing user with representative data across workouts, plans, nutrition, wellness, chat, and recommendations.  
   Test rejection of other-user access on production.  
   Test exclusion of tokens, admin flags, billing/subscription state, and blobs.  
   Test conflict handling with divergent `updatedAt` values.  
   Test failure when the target dev user does not exist.  

**Relevant files**

- `/home/simon/coach-dev/coach/server/utils/session.ts` — reuse `getServerSession()` and impersonation-aware session handling; critical for prod vs dev auth boundaries.
- `/home/simon/coach-dev/coach/server/utils/coaching.ts` — reuse `getEffectiveUserId()` style ownership resolution patterns.
- `/home/simon/coach-dev/coach/app/middleware/admin.ts` — existing admin gate for dev-only initiation UI/routes.
- `/home/simon/coach-dev/coach/server/api/admin/impersonate.post.ts` — example admin-scoped server route behavior.
- `/home/simon/coach-dev/coach/server/api/developer/apps/index.post.ts` — example route plus audit logging pattern.
- `/home/simon/coach-dev/coach/server/api/oauth/token.post.ts` — existing token issuance/validation patterns relevant to signed one-time exchange design.
- `/home/simon/coach-dev/coach/server/utils/repositories/oauthRepository.ts` — token creation and rotation reuse candidate if the sync token piggybacks on existing token infrastructure.
- `/home/simon/coach-dev/coach/server/utils/audit.ts` — reuse `logAction()` for sync audit events.
- `/home/simon/coach-dev/coach/server/utils/repositories/auditLogRepository.ts` — persistence path for audit trail.
- `/home/simon/coach-dev/coach/app/pages/admin/users/[id].vue` — likely dev-side initiation UI anchor.
- `/home/simon/coach-dev/coach/app/pages/settings/developer.vue` — alternate self-service/dev-tools UI anchor if the flow is not purely admin-facing.
- `/home/simon/coach-dev/coach/server/api/integrations/sync.post.ts` — existing manual sync endpoint pattern to mirror.
- `/home/simon/coach-dev/coach/server/utils/intervals-sync.ts` — existing sync orchestration concepts and retry/fallback structure to borrow.
- `/home/simon/coach-dev/coach/cli/import/intervals-runner.ts` — useful reference for ordered multi-entity import/apply logic and summary reporting.
- `/home/simon/coach-dev/coach/prisma/schema.prisma` — authoritative entity graph, including user-owned tables, join tables, enums, and sensitive models to denylist.
- `/home/simon/coach-dev/coach/tmp/coachwatts_live_schema.dbml` — live database reference for full-column review and allowlist/denylist design.

**Verification**

1. Build an entity inventory from the live schema and classify each table as: allowlisted, denylisted, or conditional, with explicit ownership rationale.
2. Trace production export queries to prove every row can only originate from the authenticated production user or allowed descendants.
3. Exercise manual prod-to-dev sync for one seeded user and confirm correct create/update/skip counts.
4. Exercise manual dev-to-prod sync for the same user and confirm privilege-bearing fields remain unchanged on production.
5. Validate conflict resolution by changing the same row in both environments with different `updatedAt` values.
6. Validate soft-delete behavior on supported models and confirm hard deletes do not propagate.
7. Confirm sync fails when the email is absent on dev.
8. Confirm excluded classes never appear in payloads: tokens, secrets, blobs, admin-only records, billing/subscription state.
9. Confirm audit logs capture initiation, authorization, export, import, and failure events with actor and target identifiers.

**Decisions**

- Included: manual-only sync, two-way capability, dev-initiated flow, email-based user matching, newest `updatedAt` wins, soft-delete only, no blob/file sync in v1.
- Included: all user-owned relational data in principle, but only through an explicit allowlist and field-level filtering.
- Excluded: secrets, tokens, admin-only records, role/privilege changes, billing/subscription state, and other environment-coupled operational data.
- Excluded for v1 unless later justified: automatic/scheduled sync, bulk multi-user sync, and missing-dev-user auto-provisioning.

**Further Considerations**

1. For rows lacking reliable `updatedAt`, prefer explicit source-wins-per-run or exclude those tables from v1 rather than inventing heuristics.
2. A dry-run preview before apply is likely worth including early because two-way sync plus wide scope will otherwise be hard to trust operationally.
3. If the one-time token payload becomes large, the design may need a staged export artifact rather than a direct browser round-trip.
