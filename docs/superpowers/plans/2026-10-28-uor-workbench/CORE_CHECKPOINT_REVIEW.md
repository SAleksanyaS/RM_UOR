# Independent core checkpoint review — T01–T08

Review date: 2026-10-28. Reviewed range: `34455dd96a16637d464587759239f0f1bd76bc02..8ee8910894bea4f59e1a354b5de016268cc2efa6`.
Read-only fresh-context reviewer; synthetic Node22.16.0 data. This is a checkpoint review, not final approval of the entire T00–T48 plan.

## Findings and disposition

No Critical findings. Three Important findings were reproduced before changes:

1. A published correction targeting a selected **derived** observation was silently skipped because only leaf factKeys were examined. Regression expected50 and received100. Fix: resolve corrections at the logical observation as well as its inputs, retain original/correction refs and original freshness, and apply a single aggregate scalar override. An undefined multi-aggregate redistribution returns `unsupported_correction_reduction` instead of dropping the correction or inventing arithmetic.
2. A lineage child could belong to another metric with the same unit. Regression obtained ready/100% and allowed confirmation from the wrong metric. Fix: enforce metric identity during traversal. The related scope check now requires server-verified exact directory refs. The resolver verifies an actual ancestor/descendant path with matching directory kinds; a leader link or shared ancestor does not equate unrelated scopes. Negative unrelated-link and positive product→team tests cover both boundaries.
3. Module SQL stripped single-quoted names as strings, although SQLite also accepts them as table identifiers. A synthetic UPDATE changed an immutable stored goal. Fix: reject ambiguous single-quoted structural identifiers before stripping literals; preserve namespace/table checks, core module-name reservations and parameter binding. Regression asserts the operation throws before any change and the old goal title remains intact.

RED evidence (private, local): `review-lineage-red.log`, `review-correction-sql-red.log`. GREEN evidence: `review-lineage-green.log`, `review-fixes-green.log`, `review-path-green.log` under `.runtime/validation/workbench`.

The first general test run overlapped the newly added RED regression and therefore failed on that intentionally reproduced defect. It is not completion evidence. The final general run and build after fixes are recorded in PROGRESS.md.

Minor notes: none reported.

## Review boundaries

- T09+ history/API/access/UI/real bank integrations and package verification are pending tasks, not validated by this review.
- `result.confirm` must pass a fresh quality projection to validation; accepting an unprojected stored result in that future command would violate T07/T17 even though the pure validator cannot discover wall-clock state itself.
- No second review dispatch is required for these fixes: each reproduced defect is checked RED→GREEN and followed by the general suite/build. A final whole-project review remains necessary after the remaining implementation.

## T09 planning note

The plan's proposed snapshot index name `wb_snapshot_assignment_time` falls outside the `history` module namespace. Use `wb_history_snapshot_assignment_time` for that owned index and record the technical ruling when starting T09; do not loosen module isolation to accommodate the old spelling.
