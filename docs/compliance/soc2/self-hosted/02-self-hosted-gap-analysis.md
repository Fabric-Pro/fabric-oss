# Self-Hosted Fabric — SOC 2 Gap Analysis

| | |
|---|---|
| **Status** | DRAFT v0.1 |
| **Date** | 2026-07-03 |
| **Scope** | The AWS self-hosted deployment path (`deploy/helm/fabric`, `deploy/terraform`) against SOC 2 (Security, Confidentiality, Privacy — the criteria required by the driving enterprise customer). |
| **Method** | Source-level review of the shipped Helm chart, Terraform modules, and application controls **as they exist today** — not the earlier dev/MVP framing. |

> **Headline:** the self-hosted path is materially more hardened than the
> originating ticket assumed. TLS enforcement, HA replicas, KMS encryption at
> rest, dropped container capabilities, secrets management, tenant isolation,
> and an append-only (WORM) audit log are **already shipped**. The genuine
> remaining gaps are narrow and enumerated below (G1–G7), each with an owner and
> effort estimate.

---

## Already satisfied (credit where due — with evidence)

| Area | Status | Evidence |
|---|---|---|
| TLS in transit (no HTTP-only default in prod) | **DONE** | `values-prod.yaml` `ingress.tls: true`; ALB `ssl-redirect: 443` + ACM cert (`templates/networking/ingress.yaml`); Postgres/Temporal TLS fail-closed in prod. |
| High availability (app tier) | **DONE** | `values-prod.yaml` runs `replicas: 2` for web, worker, MCP wrapper, and every agent; EKS node group autoscales (`node_min/desired/max`). |
| Encryption at rest | **DONE** | Terraform `kms` module issues customer-managed CMKs for EKS secrets, **RDS** (`storage_encrypted=true`), S3, ECR, Secrets Manager; app-layer AES-256-GCM for OAuth tokens/credentials with key rotation. |
| Automated DB backups | **DONE** | `modules/rds`: `backup_retention_period = 7`, `deletion_protection` on (when not skipping final snapshot). |
| Secrets management | **DONE** | AWS Secrets Manager + `external-secrets` operator; no secrets in the chart; IRSA/OIDC (no long-lived cloud keys). |
| Container capability hardening | **DONE** | `_deployment.tpl` baseline: `allowPrivilegeEscalation: false`, `capabilities.drop: ["ALL"]` on every container. |
| Tenant isolation (authZ) | **DONE** | `requireInputOrgPermission` membership check on the resolved input org + CI static-scan guard. |
| Append-only audit log | **DONE** | WORM Postgres trigger (rejects UPDATE/DELETE outside the controlled retention purge) + org-cascade→SET NULL. |
| Dry-run cannot run in production | **DONE** | `require-permission.ts` refuses to start with `RBAC_DRY_RUN=true` when `FABRIC_ENV/VERCEL_ENV=production` (fatal startup guard — exactly the card's "structural, not a runtime toggle" requirement). |
| Network segmentation primitives | **DONE** | VPC module + EKS `NetworkPolicy` template. |

---

## Gaps (prioritized, with owner + effort)

### G1 — No production Terraform *environment* wrapper  · Priority: HIGH · Effort: M · Owner: Fabric
The Terraform **modules** are production-capable (KMS, RDS, EKS with encryption,
S3, Secrets Manager), but only `environments/dev/` exists. A self-hosted customer
has no `environments/prod/` to `terraform apply` with production-grade inputs.
**Fix:** add `environments/prod/` mirroring `dev` with prod inputs (multi-AZ RDS,
larger node group, restricted EKS public-access CIDRs, prod KMS aliases, budgets),
plus a `terraform.tfvars.example`. *(This is the card's FR-2.)*

### G2 — RDS is single-AZ  · Priority: HIGH · Effort: S · Owner: Fabric
`modules/rds` does not set `multi_az`, so the database is a single-AZ instance —
a real availability gap for a production SOC 2 (Availability) posture. **Fix:** add
a `multi_az` variable (default `true` for the prod environment); backups +
encryption + deletion protection are already present.

### G3 — Containers run as root (`runAsNonRoot` omitted)  · Priority: MED · Effort: S · Owner: Fabric
`_deployment.tpl` intentionally omits `runAsNonRoot` "so images without a USER
directive keep working." The 12 langchain agent images were subsequently made
non-root (USER `appuser`, uid 1001), so the Helm baseline can now safely enable
`runAsNonRoot: true` (+ `seccompProfile: RuntimeDefault`, `readOnlyRootFilesystem`
where feasible) for those services. **Fix:** enable per-service pod
`securityContext` in `values-prod.yaml` now that the images support it; audit any
remaining root-only image (web/worker) and add a USER directive.

### G4 — Audit log is append-only but not cryptographically **signed**  · Priority: HIGH · Effort: M · Owner: Fabric
The WORM trigger prevents modification/deletion at the DB layer, but SOC 2
evidence for a self-hosted customer benefits from **cryptographic** tamper-evidence
independent of the DB. **Fix (in progress):** periodic signed "seal" digests over
the audit rows, chained to the previous seal and HMAC-signed with a rotating key
(AWS-CloudTrail-style log-file-validation), plus an offline verifier. Design does
not touch the audit hot path. *(This is the card's FR on tamper-evident logs.)*

### G5 — Signed container images / SBOM  · Priority: MED · Effort: M · Owner: Fabric · **ADDRESSED**
Previously images were built and pushed but not signed, with no per-image SBOM.
**Shipped:** a `sign` stage (`ci/gitlab/45-sign.yml`) that runs after the trivy
`image-scan` gate and, per image, generates a CycloneDX SBOM with Syft and signs
the image + attaches the SBOM attestation with cosign (key-based, private —
`--tlog-upload=false`, no public Rekor leak). **Opt-in:** enforced once
`COSIGN_PRIVATE_KEY`/`COSIGN_PASSWORD` are set as masked CI variables; skips
cleanly until then. **Remaining (follow-up):** deploy-time enforcement — a
`cosign verify` gate / Kyverno admission policy so only signed images roll out;
distribute the cosign public key to the cluster.

### G6 — EKS control-plane endpoint is publicly reachable  · Priority: MED · Effort: S · Owner: F+C
`cluster_endpoint_public_access = true`. Public access is CIDR-restrictable but
defaults are permissive. **Fix:** in the prod environment, set a tight
`public_access_cidrs` allowlist (or private-only endpoint) and confirm
`enabled_cluster_log_types` includes `audit`/`authenticator`.

### G7 — No written procedure templates  · Priority: MED · Effort: S · Owner: Fabric
No incident-response, change-management, access-review, or patching procedure
templates existed for the self-hosted customer. **Fix (this deliverable):**
adaptable templates under `procedures/` with Fabric-specific context pre-filled.

---

## Out of scope (v1) — consistent with the originating requirement
- Fabric obtaining its own SOC 2 report (pre-work only).
- Auditing/certifying the customer's environment directly.
- Non-AWS self-hosted (Azure/GCP) reference architectures.
- Multi-region HA / automated continuous-compliance drift detection.
- The audit-log **UI** display (tracked separately; this analysis covers the
  storage/signing layer only).

---

## Suggested sequencing
1. G2 (multi-AZ) + G3 (non-root) — small, high-value hardening.
2. G1 (prod Terraform environment) + G6 (EKS endpoint) — the production apply path.
3. G4 (signed logs) + G5 (signed images/SBOM) — supply-chain + log integrity.
4. G7 (procedure templates) — shipped with this document set.
