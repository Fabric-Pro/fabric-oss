# Patching & Vulnerability Management Procedure — TEMPLATE (self-hosted Fabric)

> Fabric-authored base template. Complete every **[CUSTOMER: …]** placeholder,
> get management approval, and retain patch records as SOC 2 evidence (CC7.1).

| | |
|---|---|
| Owner | **[CUSTOMER: patching owner]** |
| Cadence | Continuous scanning; SLA-bound remediation |

## 1. Scope
- **Fabric application** — the Fabric release the customer runs (image tags/chart).
- **Container base images** — the OS/runtime layers in the Fabric images.
- **Kubernetes / EKS** — control plane + node AMIs + add-ons.
- **Managed services** — RDS/ElastiCache engine versions.
- **Terraform providers / modules** — versions.

## 2. Vulnerability sources
- **[CUSTOMER: image scanner]** (e.g. ECR enhanced scanning / Trivy) on every image.
- The per-image **SBOM** Fabric publishes (once G5 ships) — feed it to the scanner.
- AWS security bulletins for EKS/RDS.
- Fabric release notes / security advisories. **[CUSTOMER: subscribe]**

## 3. Remediation SLA (recommended — adapt to policy)
| Severity | Remediate within |
|---|---|
| Critical | 7 days |
| High | 30 days |
| Medium | 90 days |
| Low | Next planned cycle |

## 4. Procedure
1. **Scan** — continuously scan images + infra; record findings with severity.
2. **Triage** — assign an owner + due date per the SLA; note false positives with rationale.
3. **Patch** — upgrade the Fabric release / rebuild images / bump EKS-RDS versions
   via the change-management procedure.
4. **Verify** — re-scan; confirm the finding is resolved.
5. **Record** — retain the finding, decision, patch, and verification.

## 5. Fabric release cadence
Fabric ships releases through a gated pipeline (Semgrep, `pnpm audit`, TruffleHog,
SHA-pinned Actions). The customer decides when to adopt each release and applies it
via change management. Track the delta between the running release and the latest.

## 6. Evidence to retain
Scan reports over time, the finding→remediation register with SLAs met, and patch
change tickets.
