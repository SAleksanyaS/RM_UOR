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

- [ ] Add RED full-candidate tests for independent vs conflicting capsules, bad references and source/target/tree/digest movement.
- [ ] Extract shared pure graph validation; export `validatePublicationCandidate({candidate,target})` and `assertPublicationCandidateProof(proof,input)`.
- [ ] Bind candidate to repositoryId/sourceOid/targetOid/candidateTreeOid/contentDigest; preserve honest unsupported external enforcement.
- [ ] Run candidate/apply/anchor owning regressions GREEN.

### 4. Proposal continuation F02

- [ ] Add RED local bare-Git cases: accepted main advances independently, existing own proposal continues, previous capsule bytes remain exact.
- [ ] Build a checked continuation with the prior proposal as first parent and advanced main incorporated; validate complete parents/tree/delta.
- [ ] Reject unrelated/private delta, incompatible own capsule changes and target/remote movement; use ordinary fast-forward push only in the owned fixture.
- [ ] Run staging and affected submit/gate owning tests GREEN.

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

## Verification and limitations

Pending owning RED/GREEN evidence. No claim of real Bitbucket acceptance enforcement or banking verification will be made.
