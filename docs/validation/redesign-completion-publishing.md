# Publishing and historical correctness implementation plan and log

> **For agentic workers:** Use the existing approved task ownership; implement each owning regression RED → GREEN. No additional agents, full suite, dependency changes, push or merge.

**Goal:** Complete F01/F02/F03/F04/F15 while preserving the approved reference UI, immutable saved history and external final acceptance.

**Architecture:** One historical input builder uses saved basis refs/evaluatedAt/actor. One publication graph validator serves candidate validation and reader apply. Candidate evidence binds repository/source/target/tree and bytes; Git continuation retains the existing proposal history through an ordinary fast-forward update.

**Tech Stack:** TypeScript, Zod, SQLite repository, native Git, Vitest; pinned Node 22.16.0.

**Spec:** `docs/superpowers/specs/2026-11-01-product-redesign.txt`, §14; owning findings in `docs/validation/redesign-reference/remaining-defects.txt`.

## Global constraints

- Base code ac299a5; approved reference checkpoint 32106a9 is preserved.
- Final merge remains external Bitbucket. Local validation does not establish remote enforcement.
- Only assigned publishing backend/helpers/tests, core anchor schema/tests, repository/tests and core archive codec/tests are editable; no UI/dependencies/connector/identity changes.
- Pinned PATH: `/workspace/scratch/ab925b2abe56/redesign/runtime/node-v22.16.0-linux-x64/bin:$PATH`.
- Owning Vitest runs use at most two workers. No whole suite or other runtime.
- Local commits contain only explicit owned paths and follow notification to the coordinator.

## Review focus

- Time or current-head movement cannot reinterpret a saved result; absent evaluatedAt fails explicitly.
- Missing/mismatched trusted ownership denies private candidates and lineage, regardless of actor labels.
- Candidate proof is invalid after source/target/tree/byte movement; two clean Git capsules may still conflict semantically.
- Updating the same proposal after target movement preserves old capsule bytes and exact permitted delta, without force.
- Mismatched anchor id/packageId fails schema, append and archive restore atomically; old incompatible records are not renamed.

## Tasks

### 1. Anchor identity F15

- [x] Add RED schema/repository/archive regressions for id != packageId, rollback and old persisted incompatibility.
- [x] Add the shared schema invariant and explicit boundary diagnostics without rewriting historical bytes.
- [x] Run owning schema/repository/core-codec tests GREEN.

### 2. Historical input and trusted preview candidates F03/F04

- [x] Add RED preview regressions for freshness/current-head/new-fact movement and missing evaluatedAt.
- [x] Extract `buildHistoricalEvaluationInput(basis, read, anchors)` from apply; saved VersionRefs and immutable capture revision1 only.
- [x] Use the helper from preview/apply; retain a separate current-context evaluation.
- [x] Add RED two-owner/missing-binding cases, filter candidate categories and exact lineage versions by trusted public/own provenance, remove unconditional accepts.
- [x] Run owning preview/apply tests GREEN; saved bytes remain untouched.

### 3. Exact future candidate F01

- [x] Add full-candidate tests for independent vs conflicting capsules, bad references and source/target/tree/digest movement.
- [x] Extract shared pure graph validation; export `validatePublicationCandidate({candidate,target})` and `assertPublicationCandidateProof(proof,input)`.
- [x] Bind candidate to repositoryId/sourceOid/targetOid/candidateTreeOid/contentDigest; preserve honest unsupported external enforcement.
- [x] Run candidate/apply/anchor owning regressions GREEN.

### 4. Proposal continuation F02

- [x] Add RED local bare-Git cases: accepted main advances independently, existing own proposal continues, previous capsule bytes remain exact.
- [x] Build a checked continuation with the prior proposal as first parent and advanced main incorporated; validate complete parents/tree/delta.
- [x] Reject unrelated/private delta, incompatible own capsule changes and target/remote movement; use ordinary fast-forward push only in the owned fixture.
- [x] Run staging and affected submit/gate owning tests GREEN.

## Execution log

- Initial read: AGENTS, approved spec and remaining-defects; assigned source ownership checked. The reference files were staged by root and then committed as 32106a9; this agent did not touch the shared index.
- Agreed exported contracts communicated to coordinator before implementation; no UI readmodel changes required for the initial extraction.
- F15 RED: schema, two repository tests and archive test each accepted mismatched anchor identities before the fix. Restricted-sandbox Vitest workers completed assertions but hung at shutdown; only this agent's sessions were interrupted. Coordinator confirmed the sandbox lifecycle issue; subsequent targeted runs use `sandbox_permissions=require_escalated` with isolated-local-fixture justification.
- F15 GREEN: `npm test -- src/domain/workbench/publication-anchor.schema.test.ts src/server/storage/workbench-repository.test.ts src/features/workspace-maintenance/workbench/core-codec.test.ts --maxWorkers=2` — 3 files, 22 tests, exit 0 (2026-11-01). Shared schema validates append/archive; repository opening explicitly rejects historical id/packageId mismatches without rewriting rows. Coordinator approved exactly two positive anchor-fixture adjustments in `tests/fixtures/workbench/factories.ts`; explicit mismatched negatives remain.
- F03/F04 RED: 5 new preview cases failed for missing ownership, two-owner same-time contamination, current main definition drift and historical freshness recomputation. `historical-input.ts` is now used by **both** package projection and publication apply. The helper has no clock/current entity-head dependency and requires saved evaluatedAt; capture references use immutable revision 1.
- Trusted ownership is a publication-specific helper: missing core binding fails closed, restored bindings work with unchanged historical actors, and the core candidate merge preserves exact older fact revisions used by lineage. The unconditional evaluation `accepts` was removed.
- A further RED with an attestation showed the earlier DraftService confirmation preflight still trusted actor-only private candidates. Coordinator approved one narrow `acceptsCoreVersion` callback threaded through `validateDraftPackage`/current-basis checks in `workbench-drafts.ts`. Only the publication caller supplies this stricter policy; proof, completeness, current freshness and source-attempt checks remain.
- Current `BASIS_NOT_CONFIRMABLE` after freshness expiration remains an intentional separate draft business gate; the historical saved result no longer produces a false `RESULT_MISMATCH`. Preview/core result bytes remain unchanged.
- GREEN: `npm test -- src/features/publishing/workbench/publication-apply.test.ts src/features/publishing/workbench/package-preview.test.ts --maxWorkers=2` initially verified all 61 apply tests; three preview fixtures then exposed absent trusted core bindings in the synthetic harness (production registers them). The owning fixture now binds materialized basis/result explicitly.
- Final GREEN for this block: `npm test -- src/features/publishing/workbench/package-preview.test.ts src/features/publishing/workbench/historical-input.test.ts src/features/catalog/workbench-drafts.test.ts --maxWorkers=2` — 3 files, 73 tests, exit 0. This includes direct no-current-head, missing-time and wrong-version helper checks and both assignment/attestation ownership cases. Counts above are separate runs, not a combined-suite claim.
- The first implementation checkpoint is local commit `1d3bc18` (F03/F04/F15). No project push or merge was performed. The coordinator subsequently approved three further positive fixture-only anchor pair corrections in directory/history/basis tests; deliberate mismatched negative fixtures remain unchanged.
- F01: `publication-validation.ts` now owns the graph validator shared with reader apply, plus exact-candidate validation. `PublicationCandidateInput` contains the trusted provider's complete workbench capsule tree and target tree; `PublicationCandidateProof` binds repository, source OID, target OID, candidate tree OID and SHA-256 of both file sets. Proof checking reruns semantic validation. All previously accepted capsule bytes and accepted package identity remain immutable. The selected highest unaccepted capsule revision is active; older capsule manifests, hashes, schemas and references remain checked and bytes retained.
- The exported contract has a real production callsite: `createPreTransferGate` obtains the full candidate from `git.readCandidate`, validates it, rechecks preview, reads the candidate again and asserts the proof before the fresh access gate. Native Git supplies actual source/target/tree objects and all capsule bytes. The terminal's immediate pre-push gate repeats that path. A port without this capability fails `CANDIDATE_VALIDATION_UNAVAILABLE` before preparation/push; a negative command regression protects that boundary.
- F02 RED: the new native staging continuation initially failed at the old main-ancestor guard with `PREVIEW_STALE`. The fixture's hard-coded Windows `where.exe` was also corrected, with coordinator approval, to platform-aware `where.exe`/`which`, `shell:false`, while retaining mandatory real Git. Local verification is Linux/Node 22.16.0; this is not Windows or banking certification.
- F02 GREEN: when main advanced, a private staging merge incorporates fresh main with previous own proposal as first parent and fresh main as second parent. Validation proves exact parents, prior proposal delta, the entire published tree union, new capsule bytes, and unchanged previous capsules. The same remote proposal branch advances by ordinary fast-forward push, with no force/reset/rebase. Existing unrelated/private delta, hooks and crash-recovery regressions remain.
- An additional latest-capsule RED exposed that preview still activated abandoned earlier own revisions after a successful continuation. `readMainProjection` now selects the latest capsule per package consistently with apply, while parsing and hashing every old capsule. The regression retains the old conflicting revision as historical bytes and activates the reconciled latest revision.
- GREEN before the dependency update: `npm test -- src/features/publishing/workbench/git-staging-provider.test.ts src/features/publishing/workbench/publication-validation.test.ts src/features/publishing/workbench/pre-transfer-gate.test.ts --maxWorkers=2` — 3 files, 32 tests, exit 0; separate apply extraction verification — 61 tests, exit 0.
- Coordinator replaced dependencies with its verified lock/config; this agent installed nothing. With Vitest 4.1.12: `npm test -- src/features/publishing/workbench/publishing-commands.test.ts src/features/publishing/workbench/package-preview.test.ts src/features/publishing/workbench/pre-transfer-gate.test.ts src/features/publishing/workbench/publication-validation.test.ts --maxWorkers=2` — 4 files, 78 tests, exit 0. This includes three exact-lineage ownership cases (missing, foreign, restored) and the latest-capsule preview case.
- The new actual two-curator Git test starts at accepted M, creates A/B at different capsule paths with different bytes for the same entity revision, and obtains a clean native merge. Candidate validation rejects it. Deliberately bypassing the local gate only inside the disposable bare fixture still leaves the production reader's last-good pointer and core unchanged. A second test resolves independent fields into revision 3, preserves the old proposal capsule, checks actual two-parent/tree OIDs and completes an ordinary FF proposal update and fixture acceptance.
- A seven-file native/apply/positive-fixture/submit run on Vitest 4.1.12 produced 135 PASS / 1 RED. All six native/apply/positive-fixture files passed (114 tests). The sole additional submit RED identified a second real F02 guard in `proposal-reconciliation.ts`: an older PR target rejected a new source despite a fresh preview and successful normal push. The correction permits the existing open PR to advance after the fresh job gate, retaining exact source/target readback and PR identity. An unchanged source with target movement still fails `PREVIEW_STALE`; stale post-update readback remains `REMOTE_STATE_UNKNOWN`.
- Final focused GREEN for that correction: `npm test -- src/features/publishing/workbench/proposal-reconciliation.test.ts src/features/publishing/workbench/publishing-commands.test.ts src/features/publishing/workbench/pre-transfer-gate.test.ts --maxWorkers=2` — 3 files, 37 tests, exit 0 (2026-11-01 12:57 UTC). Logs are `completion/logs/publishing-pr-target-red.log`, `publishing-repeat-pr-diagnosis.log`, `publishing-pr-target-green.log`; the earlier mixed run is `publishing-native-green.log` and intentionally retains its one RED, rather than being rewritten as a fully green run.
- `npx tsc --noEmit` exited 0 on the integrated current source; `completion/logs/publishing-typecheck.log` is empty on success. Initial new test Map tuple inference issues were corrected before this run. The coordinator owns the final build and one full suite.
- Synthetic adapters were upgraded to full actual capsule records rather than bypassing validation. The UI harness now supplies required directory/leader closure and exact candidate bytes; missing-provider negative checks remain. The UI owner independently verified `curator-panel` and `package-diff`: 2 files, 24 tests, exit 0 on Vitest 4.1.12 (`completion/logs/ui-publishing-integration-green.log`).
- `scripts/design-reference/completion-git-fixture.ts` supplies a real disposable local/bare Git provider for the explicitly synthetic completion runtime. It accepts only the named synthetic seed graph, writes actual manifests and commits, then runs the same full validator. It does not create a preview DTO, own draft or Bitbucket adapter. The UI owner will save one synthetic work change through the actual API before preview; returned baseline package IDs must not be treated as draft IDs. Runtime/browser evidence is owned by the coordinator and UI/security agents, not claimed by this helper implementation.
- The runtime owner confirmed successful actual helper seeding and full graph validation in its production runtime: synthetic main `a09d046d994cdaa10bac6e6fc417891a55f8d5d6`, tree `0f5edd47022dba213b8a56bd76f953ad38b3225a`. This confirms the local Git adapter path; final browser preview evidence remains the UI owner's check.

## Verification and limitations

Local implementation and the focused evidence above cover F01/F02/F03/F04/F15 within the assigned contracts. This is not a whole-suite claim; the coordinator performs the final integrated gate.

The proof explicitly reports `remoteAcceptance: 'not-enforced'`. A local check and ordinary FF proposal push cannot atomically constrain a later external Bitbucket merge, compare the final expected parent or prevent provider merge-tree changes. Real hosting enforcement remains unsupported until an actual protected acceptance capability is configured and verified. Final merge remains external; no new server, force-main update or fake hosting capability was introduced. Reader validation remains fail-closed if that external boundary accepts invalid content.

Historical records are not renamed or regenerated. A preexisting anchor identity mismatch blocks repository startup with an explicit error and preserves its bytes; remediation of an incompatible real workspace needs a separate reviewed migration. Trusted private ownership is enforced in the publication path and its early draft preflight callback, without silently changing the global ownership policy elsewhere. Current freshness and source-completeness gates remain separate from historical integrity.

No dependency installation, full test suite, real project push/merge, banking endpoints or user data were used by this agent. The only Git pushes/merges in tests/helper target owned disposable local bare repositories.
