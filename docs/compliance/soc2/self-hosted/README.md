# Self-Hosted Fabric — SOC 2 Audit-Readiness Package

**Status:** DRAFT v0.2 · **Date:** 2026-08-09 · **Scope:** the **self-hosted AWS deployment path** (`deploy/helm/fabric` + `deploy/terraform`)

Companion to Fabric's internal SaaS SOC 2 package (not included in this
repository), which covers
**TechFabric's own SaaS / shared infrastructure**; this folder covers the
**client-managed, self-hosted deployment path** — the surface a hosted
provider would describe as living on "client-managed systems." It maps that path to SOC 2 audit
controls so a self-hosted customer can pursue their **own** SOC 2 audit from a
defensible baseline.

> **Framing (same as the parent).** This is **pre-audit gap-analysis pre-work, not
> an attestation.** Nothing here certifies the customer's environment, and every
> draft is subject to management review. Fabric supplies the deployment, the
> control mapping, and the procedure templates; the customer operates the controls
> and owns the evidence.

## How this relates to the parent package

| Parent (`docs/compliance/soc2/`) | This package (`self-hosted/`) |
|---|---|
| Fabric SaaS / shared infra (Azure evidence) | Customer self-hosted stack (AWS Terraform/Helm) |
| `05-…-control-matrix.md` — TSC matrix for the SaaS | `01-shared-responsibility-matrix.md` — **F vs C vs shared** split for self-hosted |
| `policies/` — Fabric's **own** org policies | `procedures/` — **customer-facing templates** the self-hoster completes |

The parent `policies/` (e.g. `incident-response-policy.md`,
`change-management-policy.md`) are *Fabric's* internal policies. The
`procedures/` here are *deployment-specific operational templates* a self-hosting
customer fills in and runs — different audience, different artifact, no overlap.

## Contents

| Document | Purpose |
|---|---|
| [`01-shared-responsibility-matrix.md`](./01-shared-responsibility-matrix.md) | Which SOC 2 controls are Fabric-managed vs. customer-managed vs. shared — the auditor's scoping tool. |
| [`02-self-hosted-gap-analysis.md`](./02-self-hosted-gap-analysis.md) | Original 2026-07-03 engineering baseline for gaps G1–G7. Several items subsequently shipped; check the current product documentation for current status. |
| [`03-production-reference-architecture.md`](./03-production-reference-architecture.md) | The recommended production topology (VPC/EKS/RDS/ElastiCache/S3/Secrets Manager) with a diagram and the production inputs to set. |
| [`procedures/incident-response.md`](./procedures/incident-response.md) | Adaptable IR procedure (Fabric context pre-filled). |
| [`procedures/change-management.md`](./procedures/change-management.md) | Repository-agnostic merge-review and optional production-promotion implementation guide for GitHub, GitLab, and Azure DevOps, including normal/emergency evidence requirements. |
| [`procedures/access-review.md`](./procedures/access-review.md) | Adaptable quarterly access-review procedure. |
| [`procedures/patching.md`](./procedures/patching.md) | Adaptable patching / vulnerability-management procedure. |

## Summary of current state

The self-hosted path is materially more hardened than early framing assumed.
**Already shipped:** TLS-only prod ingress, ≥2 replicas across the Fabric
application tier, a production Terraform profile that defaults RDS to Multi-AZ,
customer-managed KMS encryption at rest (RDS/EKS-secrets/S3/ECR/Secrets Manager),
automated RDS backups + deletion protection, Secrets Manager + external-secrets
(no secrets in the chart), dropped container capabilities +
no-privilege-escalation, tenant-isolation authZ, an append-only (WORM) audit log,
and a fatal startup guard that prevents dry-run mode in production. The bundled
Qdrant StatefulSet remains single-node; production operators should use an
appropriately resilient external Qdrant service where vector-store HA is required.

The original gap analysis remains as a dated baseline. Since it was written, the
production Terraform profile (including RDS Multi-AZ by default), non-root
container baseline, periodic cryptographic audit-log sealing, and procedure
templates have shipped. Remaining customer/Fabric decisions include resilient
vector storage, EKS endpoint restriction, deploy-time enforcement of signed
artifacts, and the organizational or provider-owned controls tracked in
Fabric's internal remediation register (not included in this repository).

## Procedure templates — how to use

Each template is Fabric-authored with product-specific context pre-filled. The
customer replaces the **[CUSTOMER: …]** placeholders, obtains management approval,
and retains the completed/signed documents (and per-incident/-change/-review
records) as SOC 2 operating evidence.

For change management, use the existing
[`procedures/change-management.md`](./procedures/change-management.md) as the
single canonical guide: select the recipe for the customer's SCM/CI provider,
configure reviewer and bypass identities in that provider, and retain both the
effective settings and the complete normal/emergency change population. The
auditor selects samples from that population. Independent
merge review is the baseline described by the template. Production-promotion
approval is a distinct customer choice and remains off until the customer
enables it; leaving it off does not add a gate to the customer's configured
automatic-promotion path. The shipped GitLab production job remains separately
disabled pending its documented DEV/PROD variable-isolation prerequisite.
