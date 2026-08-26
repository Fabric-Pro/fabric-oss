# ADR-007: AI-Driven Security & Accessibility Scanning over Fabric-Held Context

- **Status**: Accepted
- **Date**: 2026-06-16
- **Deciders**: Engineering team

## Context

Fabric needed continuous security and accessibility review of project work
(see [`../features/security-accessibility-scanning.md`](../features/security-accessibility-scanning.md)
for the canonical feature documentation), satisfying five acceptance criteria:

1. A security agent scans and surfaces findings with severity + remediation.
2. An accessibility agent checks the described UI in feature documents against
   WCAG 2.1 AA.
3. Custom (industry-specific) rules are applied and attributed to their source
   rule set.
4. A clean scan is confirmed with a timestamp.
5. Findings are a soft warning by default — non-blocking unless enforcement is
   escalated.

The material question was **what does "scanning" operate on, and with what
engine**. Fabric's primary artifacts at the point of review are *design-time*:
features (user stories with acceptance criteria) and generated documents
(PRDs, specs, architecture docs). A built, deployable application with running
endpoints and rendered DOM frequently does not exist yet when a team wants the
review.

A separate decision was how to surface results so that re-scanning behaves
predictably, and how to keep the LLM integration from being brittle.

## Decision

Build the scanners as **LLM agents that analyse Fabric-held context** — the
project's features and generated documents — orchestrated by a Temporal
workflow on the `fabric-worker` queue. The security agent evaluates against the
OWASP Top 10 plus custom rules; the accessibility agent against WCAG 2.1 AA
plus custom rules. Findings persist as `ScanFinding` rows, each attributed to
its rule set via a human-readable `ruleSource` and an `isCustomRule` flag.

**Hybrid engine (added):** the LLM design-time scan is complemented by a real
**Semgrep SAST** scan over the project's connected repository (opt-in via
`ProjectScanConfig.semgrepEnabled`, project-scope only). Semgrep findings flow
into the same `ScanFinding` model (`category: SECURITY`, `ruleSource:
"Semgrep: <rule>"`) and the same UI. This is the "best-practice" layer: the LLM
reasons about *described* designs where no code exists; Semgrep gives ground-truth
code-level findings where a repository is connected. The two are complementary,
not competing — both run when enabled. The Semgrep step degrades gracefully (no
repo / no binary / clone failure → skipped, LLM scan still completes) and is
gated behind `patched("security-scan-semgrep-v1")` for replay safety. Every
finding field (LLM and Semgrep) passes through a secret redactor before
persistence, so a discovered credential is never stored.

Three supporting decisions:

- **Permissive model schema, normalize in code.** The model-facing
  `generateObject` schema uses plain optional strings — no `z.enum`, no
  `z.preprocess` — and severity/rule-type/title are normalized and defaulted in
  application code.
- **Default the findings view to the latest *completed* scan.** Re-running a
  scan replaces the displayed results rather than accumulating across runs.
- **Soft-warning default.** Scans are dispatched fire-and-forget; nothing in the
  maturation path awaits or gates on the result. `BLOCK` enforcement is modelled
  but not the default.

## Alternatives Considered

### Integrate a conventional SAST / a11y toolchain (Semgrep, CodeQL, axe-core, Lighthouse)

These tools are excellent but operate on **built artifacts** — source trees for
SAST, a rendered DOM for axe/Lighthouse. At the point in the Fabric lifecycle
where review is wanted (planning, spec, pre-implementation), there is often no
repository to scan and no page to render. They also cannot reason about
*described* designs ("invite tokens are single-use and expiring" → "but the
description never says they're generated from a CSP-secure source"), which is
exactly where design-time review adds value. They remain complementary — and we
**have** layered Semgrep over the connected repository as the code-time engine
(see the Decision above): the LLM design-time scan and Semgrep run together when
enabled. axe-core/Lighthouse for rendered-UI accessibility stays future work, as
it needs a running deployment to scan. (Semgrep already runs in CI for Fabric's
own code, so the rule packs and version are house-vetted.)

### Reuse an existing in-repo agent / the Atlas analysis pipeline

The closest existing machinery is Atlas and the backlog
analysis activities. Neither targets OWASP/WCAG, neither carries a per-finding
severity + remediation + rule-attribution contract, and bending either to fit
would have coupled two unrelated feature surfaces. A dedicated, narrowly scoped
pipeline (three models, one workflow, focused prompts) was simpler and keeps the
finding contract clean.

### Strict typed model schema (`z.enum`, `z.preprocess`)

The natural first instinct is a strict schema that validates the model output
into the canonical enums directly. In practice this is brittle: the model emits
synonyms and mixed case (`"Critical"`, `"Serious"`), and occasionally omits a
field on large result sets — each of which fails the whole parse and aborts the
scan. A `z.preprocess` wrapper to normalize before the enum is worse: it emits a
JSON-schema node with no `type`, which the AI gateway rejects before the model
even runs. The permissive-schema-plus-code-normalization approach is the robust
one.

### Accumulate findings across scans (issue-tracker model)

The findings list could accrue every open finding across all runs, like an
issue tracker. Without a stable per-finding fingerprint this produces literal
duplicates on every re-scan (the same issue, found again, as a new row) and
makes the header count disagree with the list. Defaulting the view to the
latest completed scan gives a predictable "current assessment" model; a
fingerprint-based dedup that carries resolutions across runs is a possible
future enhancement, not a v1 requirement.

## Consequences

### Positive

- Review works at design time, before any code exists — the stage where Fabric
  operates and where catching a missing security/accessibility requirement is
  cheapest.
- The scanners reason about *described intent*, surfacing gaps a tool over built
  artifacts cannot ("the design never specifies how tokens are generated").
- One clean finding contract — category, severity, remediation, rule
  attribution — drives a single UI and a single notification.
- The permissive-schema pattern makes the LLM integration resilient to model
  vocabulary drift and is reusable by other `generateObject` call sites.
- Re-scanning is predictable: the view reflects the latest assessment, header
  and list agree.

### Negative

- Findings are only as good as the described context. A vague feature yields
  vague findings; the scanners cannot see implementation details that were never
  written down. Mitigated by scanning generated documents (richer than stubs)
  and by labelling each context section so attributions point at a real source.
- LLM cost and latency per scan (bounded by content truncation, a `COMPLEX`
  task-type model, low retry counts, and per-run telemetry for visibility).
- Resolutions do not carry across runs in v1: resolving a finding and then
  re-scanning re-surfaces the underlying issue as a new finding. Acceptable for
  a soft-warning advisory tool; revisited if/when fingerprint dedup is added.

### Neutral

- This decision does not preclude a future code-time scan over an indexed
  repository (Semgrep/axe); that would be an additional `ScanTargetType` and
  context source, not a replacement.
- `BLOCK` enforcement is modelled in the schema but intentionally inert in v1.

## References

- [`../features/security-accessibility-scanning.md`](../features/security-accessibility-scanning.md) — canonical feature documentation.
- [ADR-003: XOR tenant isolation](003-xor-tenant-isolation.md) — the tenant pattern the scan tables follow.
- [ADR-001: Temporal-only dynamic agents](001-temporal-only-dynamic-agents.md) — why the pipeline is a Temporal workflow.
- OWASP Top 10 (2021) — the security rule set.
- WCAG 2.1 Level AA — the accessibility rule set.
