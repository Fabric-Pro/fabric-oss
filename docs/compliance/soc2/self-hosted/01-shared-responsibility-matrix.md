# Self-Hosted Fabric — SOC 2 Shared-Responsibility Matrix

| | |
|---|---|
| **Status** | DRAFT v0.2 |
| **Date** | 2026-08-09 |
| **Applies to** | Fabric self-hosted deployment on AWS (Helm chart `deploy/helm/fabric` + Terraform `deploy/terraform`) |
| **Audience** | Self-hosted customers and their external SOC 2 auditors |
| **Purpose** | Delineate which SOC 2 controls are supported by the **Fabric software** (vendor-managed) versus the **customer's operation of it** (customer-managed), so an auditor can scope the customer's audit boundary without Fabric being a direct audit subject. |

> **This is not a Fabric certification.** Fabric provides the software, its
> security controls, and this matrix. The customer runs the software in their own
> AWS account and is responsible for their own SOC 2 audit. "Fabric-managed"
> below means "implemented in the shipped code/artifacts"; the customer still
> **operates, configures, and monitors** those controls and collects the dated
> operating evidence their auditor requires.
>
> **Escalation / control disputes:** if an auditor disputes a control assignment
> below, the customer escalates to their Fabric technical contact (see the
> deployment hand-off), who will clarify or amend this matrix.

Legend: **F** = Fabric-managed (in the shipped software/artifacts) · **C** =
Customer-managed (operation/config in the customer's AWS account) · **F+C** =
shared (Fabric provides the mechanism; customer configures/operates it).

---

## CC6 — Logical & Physical Access Controls

| Control | Owner | How it is met (self-hosted) |
|---|---|---|
| CC6.1 Application authorization / tenant isolation | **F** | oRPC `requireInputOrgPermission` verifies membership of the resolved input organization on every tenant call; multi-tenant XOR filtering; a CI static-scan guard blocks regressions. |
| CC6.1 Authentication | **F** | Better Auth: verified-email-gated sign-in, brute-force lockout, TOTP 2FA + account-level 2FA lockout (better-auth's built-in `accountLockout`: 10 consecutive failed sign-in verifications → 15-minute lock, resets on success; requires the `two_factor` lockout-columns migration), secure OAuth account-linking, `BETTER_AUTH_SECRET` boot guard. |
| CC6.1 Org-wide MFA **enforcement** | **F+C** | Fabric ships an org-wide MFA-enforcement toggle; the customer decides to enable it and manages the enrollment rollout. |
| CC6.1 Cloud IAM / least-privilege roles | **C** | Customer's AWS IAM, EKS RBAC, and access to the cluster/Secrets Manager. Terraform uses IRSA (`app-irsa`) and OIDC for CI so no long-lived keys ship. |
| CC6.1 Network perimeter / segmentation | **F+C** | Fabric ships a VPC module, EKS `NetworkPolicy`, and a TLS-terminated ALB ingress; the customer configures CIDRs, WAF, and restricts the EKS public endpoint. |
| CC6.6 Encryption in transit | **F+C** | Prod Helm values enforce HTTPS (ALB `ssl-redirect: 443`, ACM cert). The Postgres and Temporal API clients refuse plaintext by default but retain named emergency overrides; the Temporal worker has no equivalent production guard. The customer provides the certificate/domain, configures worker TLS, and restricts override variables. |
| CC6.7 Encryption at rest | **F+C** | Terraform provisions customer-managed **KMS** keys for EKS secrets, **RDS** (`storage_encrypted`), S3, ECR, and Secrets Manager; app-layer AES-256-GCM encrypts OAuth tokens/credentials with key rotation. Customer owns key rotation policy on their CMKs. |
| CC6.2/CC6.3 Access provisioning & reviews | **C** | Customer provisions/deprovisions its own users (app roles + AWS IAM) and runs periodic access reviews (template provided — see `procedures/access-review.md`). |

## CC7 — System Operations (monitoring, logging, incident response)

| Control | Owner | How it is met (self-hosted) |
|---|---|---|
| CC7.2 Audit logging | **F** | Structured `AuditLog` with actor/resource snapshots, closed action taxonomy, unconditional secret redaction, correlation IDs; login/role-change events audited. |
| CC7.2 Log tamper-evidence | **F** | Append-only **WORM** database trigger (rejects UPDATE/DELETE outside the controlled retention purge) + org-cascade→SET-NULL so the trail survives deletions, plus periodic cryptographic sealing and offline verification. |
| CC7.1/CC7.2 Infrastructure logging & monitoring | **F+C** | Fabric ships Fluent Bit + OpenTelemetry collector manifests; the customer routes them to their SIEM/log store, sets retention to their audit window, and reviews alerts. |
| CC7.3/CC7.4 Incident response | **F+C** | Fabric provides an IR procedure template (`procedures/incident-response.md`) with product-specific context; the customer adopts it, names responders, and runs/retains a tabletop. |

## CC8 — Change Management

| Control | Owner | How it is met (self-hosted) |
|---|---|---|
| CC8.1 Change-control mechanism and deployment assets | **F** | Fabric supplies versioned release/deployment artifacts and the provider-neutral merge-review, optional production-promotion, emergency-change, and evidence template in `procedures/change-management.md`. These assets support the customer's control design; they do not configure or prove a human approval in Fabric's or the customer's provider. |
| CC8.1 Customer configuration and operation | **C** | Customer management selects reviewer/deployer groups and approval counts, configures protected branches and provider-managed production environments, restricts bypass and production credentials, operates normal/emergency approvals, and retains dated configuration plus the complete change population. The production-promotion gate is optional and off until the customer enables it. |
| Supply-chain integrity (signed images + SBOM) | **F+C** | Fabric ships an opt-in GitLab signing stage that produces CycloneDX SBOMs and cosign signatures. The customer supplies protected signing credentials, verifies the stage is enabled, records immutable digests, and owns deploy-time verification/admission enforcement. |

## CC9 / Availability — Resilience, backup, DR

| Control | Owner | How it is met (self-hosted) |
|---|---|---|
| A1 High availability | **F+C** | Prod Helm values run ≥2 replicas across the Fabric application tier, and the production Terraform profile defaults RDS to Multi-AZ. The bundled Qdrant StatefulSet is single-node; the customer selects and operates an appropriately resilient external Qdrant service when vector-store HA is required, and validates the effective RDS/EKS configuration. |
| A1 Backup | **F+C** | RDS automated backups (7-day retention) + deletion protection ship in the Terraform `rds` module; the customer owns backup **restore testing** and retention policy. |
| A1 Disaster recovery | **C** | Customer owns the DR plan, RTO/RPO targets, and any multi-region strategy (single-region HA is in scope; multi-region is out of scope v1). |

## C1 / P — Confidentiality & Privacy

| Control | Owner | How it is met (self-hosted) |
|---|---|---|
| C1 Data retention & disposal | **F+C** | Fabric ships automated project soft-delete → permanent cascade delete (Postgres + vectors + file blobs) and request-telemetry TTL; the customer sets retention periods to its policy. |
| P Data residency / classification | **C** | All data lives in the customer's own AWS account/region; the customer owns data classification and residency. |
| Third-party subprocessors | **F+C** | For self-hosted, the only external processors are the **AI model providers** the customer configures (and any integrations its users connect). Fabric documents them; the customer collects attestations. |

---

## How to use this matrix in an audit

1. The customer's auditor scopes the audit to the **C** and **F+C** rows — those
   are the customer's controls to demonstrate as operating.
2. For **F** rows, the customer references this matrix + the Fabric software
   evidence (source-level control implementation) as inherited/vendor controls.
3. Every **F+C** row requires the customer to show it **configured and monitors**
   the mechanism Fabric ships — an enabled-but-unused control does not pass.

*Companion documents: `02-self-hosted-gap-analysis.md` (original 2026-07-03
baseline), the parent `06-remediation-hand-off-register.md` (current status),
`03-production-reference-architecture.md`, and `procedures/` (adaptable templates).*
