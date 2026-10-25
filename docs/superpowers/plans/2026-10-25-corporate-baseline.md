# Corporate baseline implementation plan

> **For agentic workers:** use superpowers:subagent-driven-development. User authorizes parallel implementation without intermediate approvals; Git history replacement explicitly confirmed.

**Goal:** чистая переносимая0.4.0, недельная текстовая сводка, документация для человека и агента.
**Architecture:** existing feature slices, typed weekly entity in shared catalog, clean allowlisted distribution/bootstrap scripts, current documentation front door and separately archived history.
**Tech Stack:** Node/TypeScript/React/Fastify/SQLite, Git, Markdown, Vitest.
**Spec:** ../specs/2026-10-25-corporate-baseline-design.md

## Constraints and review focus

No public credentials/corporate data; no loss of current local workspace; only a confirmed final history rewrite after durable archive. Empty data stays unknown. Weekly text never confirms goals. Revision/CAS and owner authorization apply on server. Support exact configured roots and safe paths; reject overwriting existing installs or symlink escape. Documents identify accepted versus bank-only behavior.

- [ ] Weekly agent: `src/features/weekly-report/{contracts,service,routes,WeeklyReportPage,weekly-report.css,*.test}.*`, guide; typed entity, own draft/CAS, reader shared-only, four sections, weeks/filter, clear publication handoff. Tests first.
- [ ] Architecture agent: `docs/architecture/module-map.md`, `docs/agents/START_HERE.md`; actual exports and coupling audit, minimal justified recommendations.
- [ ] Human docs agent: `README.md`, `docs/USER_GUIDE.md`; real navigation/action→result, setup/credentials/transfer and weekly guide.
- [ ] Root: bootstrap/config-file provisioning/allowlisted export scripts and focused isolated tests. Public placeholder credentials file and ignored private editing file. No mutation of live database for clean export.
- [ ] Root: register weekly routes/validation/navigation/permissions; version/manifest, reusable boundary fixes if justified; current master/handoff and links. Test actual combined revision once after stable modules; scoped fixes only.
- [ ] Root: run published local app, inspect weekly blank/draft without fake shared reports; validate fresh empty distribution and secret exclusions. Preserve full history archive branch+bundle, create clean-root main/release with exact leases, verify remote refs and one-commit main. Show user artifact links and simple guide.
