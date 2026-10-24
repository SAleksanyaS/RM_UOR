# Project instructions

Read `docs/AI_PDLC_HANDOFF.md`, the current master spec and the relevant implementation plan before changing product behavior. The latest direct user instruction takes precedence; update the documents when the requirements change.

The application is «Рабочее место УОР ДИТ Operations». UOR means «управление обеспечения развития».

This repository starts with design documents. Do not claim `npm run dev`, integrations or tests work until the implementation exists and has actually been checked.

Initial implementation starts with prepared local knowledge/data. The real corporate browser collector stays an explicitly labelled stub until its separate phase.

Keep application startup inside an approved workspace. Keep `.runtime`, personal imports, browser profiles, credentials and plaintext curator codes out of publication. The public test repository contains anonymized examples; production data is imported in the appropriate corporate environment.

Preserve the key domain rules: separate official/internal targets; separate actual result and curator validation; regression becomes not-met automatically; attestations are bound to an evaluation fingerprint; zero applicable data is unknown.

The director's view must include named IT leaders and drill-down, with consistent totals and visible provenance. Use a coherent visual design and verify it in a real browser.

Curators publish shared content to `release/current`; the UOR lead releases to `main` using a merge commit. Never resolve independent curator writes by overwriting remote history. Preserve drafts on errors.

Git hosting, allowed paths, source URLs and platform-specific browser/auth settings belong in configuration and adapters, not business calculations.

Use relevant verification for meaningful changes and report what was actually exercised. Do not introduce extra human approval steps when the current task already authorizes an action. Do not interpret the application's future curator release workflow as a requirement to open a PR for every documentation task in this test repository.
