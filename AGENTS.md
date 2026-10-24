# Project instructions

Read `docs/AI_PDLC_HANDOFF.md`, the current master spec and the relevant implementation plan before changing product behavior. The latest direct user instruction takes precedence; update the documents when the requirements change.

The application is «Рабочее место УОР ДИТ Operations». UOR means «управление обеспечения развития».

The first local application stage is implemented. Read README and docs/first-stage-validation.md for actual capabilities and limits; design requirements are broader than the current UI. Claim startup, integration or test results only after checking the current revision.

Initial implementation starts with prepared local knowledge/data. The real corporate browser collector stays an explicitly labelled stub until its separate phase.

Keep application startup inside an approved workspace. Keep `.runtime`, personal imports, browser profiles, credentials and plaintext curator codes out of publication. The public test repository contains anonymized examples; production data is imported in the appropriate corporate environment.

Preserve the key domain rules: separate official/internal targets; separate actual result and curator validation; regression becomes not-met automatically; attestations are bound to an evaluation fingerprint; zero applicable data is unknown.

The director's view opens on all active goals, a separate goal-level DIT status, named IT leaders and drill-down. Any goal can be selected, including one without data. Never average unlike goal metrics or confuse goals with assignments. Use a coherent visual design and verify it in a real browser when the viewer is available; record unperformed visual checks honestly.

Curators publish shared content to `release/current`; the UOR lead releases to `main` using a merge commit. Never resolve independent curator writes by overwriting remote history. Preserve drafts on errors.

Git hosting, allowed paths, source URLs and platform-specific browser/auth settings belong in configuration and adapters, not business calculations.

Use relevant verification for meaningful changes and report what was actually exercised. Do not introduce extra human approval steps when the current task already authorizes an action. Do not interpret the application's future curator release workflow as a requirement to open a PR for every documentation task in this test repository.
