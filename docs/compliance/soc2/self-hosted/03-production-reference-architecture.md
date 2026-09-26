# Self-Hosted Fabric — Production Reference Architecture (AWS)

| | |
|---|---|
| **Status** | DRAFT v0.1 |
| **Date** | 2026-07-03 |
| **Scope** | The recommended **production** topology for a single-region, highly-available AWS deployment of Fabric, aligned to SOC 2 (Security/Availability/Confidentiality). Grounded in the shipped `deploy/terraform` modules and `deploy/helm/fabric` chart. |

> This blueprint is the target a self-hosted customer deploys against. Where the
> shipped Terraform/Helm already implements a control, it is noted inline; where a
> production input differs from the current `dev` defaults, it is flagged
> **[prod input]** and cross-referenced to the gap analysis (G1–G7).

---

## Topology

```
                          Internet
                             │  HTTPS (443)
                             ▼
                    ┌──────────────────┐
                    │  AWS WAF (opt.)  │   [customer-managed]
                    └────────┬─────────┘
                             ▼
                 ┌───────────────────────┐
                 │   Application LB (ALB) │  TLS-terminated, ACM cert,
                 │   ssl-redirect 443     │  HTTP→HTTPS redirect  (Helm ingress)
                 └───────────┬───────────┘
   ┌─────────────────────────┼──────────────────────── VPC (multi-AZ) ──────────┐
   │  Public subnets (AZ-a, AZ-b): ALB, NAT GW                                   │
   │                          │                                                   │
   │  Private subnets (AZ-a, AZ-b):                                              │
   │   ┌───────────────── EKS cluster (encrypted secrets, node autoscaling) ──┐  │
   │   │  web ×2   temporal-worker ×2   mcp-stdio-wrapper ×2   agents ×2 each  │  │
   │   │  qdrant   otel-collector   fluent-bit   (NetworkPolicy between pods)  │  │
   │   └───────────┬───────────────┬───────────────┬──────────────────────────┘  │
   │               │               │               │                              │
   │        ┌──────▼─────┐  ┌──────▼──────┐  ┌─────▼──────┐   ┌───────────────┐   │
   │        │ RDS Postgres│  │ ElastiCache │  │  S3 (KMS)  │   │Secrets Manager│   │
   │        │ 16, KMS,    │  │ Redis (TLS) │  │  blobs     │   │ (external-    │   │
   │        │ Multi-AZ*,  │  │             │  │            │   │  secrets op.) │   │
   │        │ backups 7d  │  └─────────────┘  └────────────┘   └───────────────┘   │
   │        └─────────────┘                                                        │
   └──────────────────────────────────────────────────────────────────────────────┘
        KMS CMKs: eks-secrets · rds · s3 · ecr · secrets   (customer-managed keys)
        * Multi-AZ RDS is a [prod input] — see gap G2.
```

---

## Layers & controls

### Network (VPC)
- Multi-AZ VPC (public + private subnets across ≥2 AZs). ALB and NAT gateways in
  public subnets; **all workloads and data stores in private subnets**.
- EKS pod-to-pod traffic constrained by `NetworkPolicy` (shipped).
- **[prod input, G6]** Restrict the EKS control-plane public endpoint to an
  operator CIDR allowlist (or make it private-only). Enable a WAF on the ALB.

### Ingress / TLS (CC6.6)
- ALB terminates TLS with an ACM certificate; HTTP is redirected to HTTPS
  (`ssl-redirect: 443`). No HTTP-only listener in production (`values-prod.yaml`).
- Temporal Cloud and ElastiCache connections use TLS; the Temporal client refuses
  plaintext in production. Every internal path is listed under *Internal traffic*.

### Internal traffic (CC6.7)
Services call each other on cluster DNS over plain HTTP/gRPC: the chart ships no
service mesh and no per-service certificates. The traffic is encrypted by the node
hardware instead. The `eks` module accepts only node types that encrypt traffic
between instances (Nitro, 256-bit AEAD, AWS-managed keys, so there is nothing to
rotate) and fails `terraform plan` on any other type (`require_encryption_in_transit`,
default `true`). Two pods on the same node never put their traffic on the network.

| Path | Protocol | Protection |
|---|---|---|
| web ↔ agents, web → MCP wrapper, worker → agents, agents → web | HTTP, cluster DNS | Nitro encryption between nodes; bearer keys authenticate the call |
| app pods → Qdrant | HTTP/gRPC 6333/6334, API key | Nitro encryption between nodes |
| app pods → OTel collector | OTLP gRPC to the pod's own node (`hostPort`) | Node-local; never crosses the VPC |
| ALB → web and PartyKit pods | HTTP | **Not covered.** A load balancer hop is outside instance-to-instance encryption. **[customer]** enable VPC Encryption Controls (ALBs move to encrypting hardware; enforce mode refuses unencrypted resources), or terminate TLS in the pod behind an HTTPS target group |
| pods → RDS Postgres | TLS (RDS 16 rejects plaintext; `PGSSLMODE=no-verify`) | Encrypted, but the server certificate is **not verified**. Moving to `sslmode=verify-full` with the RDS CA bundle mounted is an open item; the Terraform-built `DATABASE_URL` also carries no `sslmode`, which the application's production guard requires |
| pods → ElastiCache Redis | `rediss://` + AUTH token | TLS (transit encryption on) |
| pods → Temporal Cloud | gRPC | TLS, fail-closed in production |
| pods → S3, Secrets Manager, CloudWatch | HTTPS | TLS |

A requirement for TLS on every service-to-service call, rather than encryption on
the wire, needs a service mesh (for example Linkerd or Istio); none is shipped.

### Compute (EKS)
- Managed node group with autoscaling (`min/desired/max`), spread across AZs.
- EKS secrets encrypted with a customer-managed KMS key (`cluster_encryption_config`).
- Every workload runs with `allowPrivilegeEscalation: false` and all Linux
  capabilities dropped. **[prod input, G3]** enable `runAsNonRoot` +
  `seccompProfile: RuntimeDefault` per service (agent images are non-root).
- HA: ≥2 replicas per long-running service (`values-prod.yaml`). Add a
  `PodDisruptionBudget` per service for controlled draining.

### Data stores
- **RDS Postgres 16** — `storage_encrypted` with a CMK, 7-day automated backups,
  deletion protection. **[prod input, G2]** enable **Multi-AZ** for HA/DR.
- **ElastiCache Redis** — in-transit TLS (min TLS 1.2), non-SSL port disabled.
- **S3** — private buckets, default SSE with a CMK; used for file blobs.
- **Secrets Manager** — all app secrets; surfaced to pods via the
  `external-secrets` operator. No secrets in the chart or images.

### Identity & access (CC6.1)
- Workloads assume IAM roles via **IRSA** (no long-lived keys in pods).
- CI/CD authenticates via OIDC (`gitlab-oidc`), no stored cloud credentials.
- Application authorization is tenant-membership-verified in code
  (`requireInputOrgPermission`).

### Observability & audit (CC7.1/CC7.2)
- Fluent Bit + OpenTelemetry collector ship container logs/metrics/traces.
  **[customer]** route to a SIEM/log store, set retention to the audit window,
  and review alerts.
- Application `AuditLog` is append-only (WORM) with actor/resource snapshots and
  secret redaction. **[G4]** cryptographic seal-signing of the log is being added.

### Supply chain (CC8.1)
- Images built from pinned bases and pushed to ECR (KMS-encrypted).
  **[G5]** image signing (cosign) + per-image SBOM are being added; the customer
  verifies signatures/digests before rollout.

---

## Deployment order (summary)
1. `terraform apply` the **prod** environment (VPC → KMS → EKS → RDS → ElastiCache
   → S3 → Secrets Manager → cluster controllers). **[G1]** the prod environment
   wrapper is being added.
2. Populate the remaining Secrets Manager groups (auth, ai-providers, oauth,
   integrations, temporal, storage, email, payments) per `docs/deployment/BOOTSTRAP.md`.
3. `helm upgrade --install` with `values-prod.yaml` + `global.domain` +
   `ingress.certificateArn`.
4. Run the `migrate` and `seed` jobs; apply RLS.
5. Verify: HTTPS-only, ≥2 replicas healthy, RDS Multi-AZ, backups enabled,
   audit-log seals producing, no dry-run permitted.

*See `02-self-hosted-gap-analysis.md` for the items still marked [prod input].*
