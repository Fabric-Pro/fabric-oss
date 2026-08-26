# Fabric Helm chart

Single-chart deployment of the Fabric multi-tenant SaaS platform on Amazon EKS.

The chart renders **15 Kubernetes services**:

- `web` — Next.js app
- `temporal-worker` — Temporal worker process
- `mcp-stdio-wrapper` — MCP stdio<>HTTP bridge
- **11 LangGraph agents**: `document-generator`, `project-document-generator`,
  `task-planner`, `story-breakdown`, `api-agent`, `prompt-enhancer`,
  `data-analyst`, `backlog-updater`, `weave-readers`, `weave-shuttle`,
  `weave-planners`
- `qdrant` — self-hosted Qdrant vector DB, single-node StatefulSet with an EBS
  PVC; set `qdrant.enabled: false` + `qdrant.externalUrl` to use Qdrant Cloud
- `custom-agent-runtime` is wired but disabled by default

…plus the cluster-side glue: ALB Ingress, External Secrets, OpenTelemetry
Collector, Fluent Bit, optional NetworkPolicy.

Note: `values-dev.yaml` runs only the 8 non-weave agents and disables Fluent
Bit (the 3 weave agents + Fluent Bit are deferred pending fixes), while
`values-prod.yaml`/`values.yaml` include all 11 agents.

## Prerequisites

The chart assumes the following are already installed on the cluster:

- Amazon EKS (Kubernetes ≥ 1.28)
- **AWS Load Balancer Controller** (manages ALB Ingress resources)
- **External Secrets Operator** with a `ClusterSecretStore` named
  `aws-secrets-manager` (overridable via `externalSecrets.secretStore`)
- **External DNS** (only if you set `global.domain` to a Route 53 zone)
- An IRSA role for the `fabric` ServiceAccount (its ARN goes into
  `serviceAccount.roleArn` — populated by the Terraform module)

The 14 Fabric-built images (web, temporal-worker, mcp-stdio-wrapper, and the 11
agents) must be pushed to the ECR registry referenced by `global.imageRegistry`
and tagged with `global.imageTag`. Qdrant pulls the upstream `qdrant/qdrant`
image from Docker Hub.

This cluster has no default StorageClass (only an unmarked `gp2`), so set
`qdrant.storage.storageClassName: gp2` explicitly (as values-dev.yaml does)
until a default `gp3` `ebs.csi.aws.com` StorageClass is created.

## Install

```bash
helm install fabric . -f values-dev.yaml -n fabric --create-namespace
```

## Upgrade (also handles first install via `--install`)

```bash
helm upgrade --install fabric . -f values-dev.yaml -n fabric \
  --atomic --timeout 15m
```

`--atomic` rolls back automatically if any resource fails to become ready
within `--timeout`. Both commands above still need the environment wiring
below — the values files carry sizing only.

## Change approval and production promotion

The chart deliberately exposes no code-review or deployment-approval value.
Protected-branch review and optional production-environment approval belong in
the customer's SCM/CI provider control plane, where reviewer identity, bypass,
protected credentials, and approval evidence can be enforced. A deploy job may
reference a provider-managed production environment, but Helm receives the
already-authorized artifact and cannot establish who reviewed or approved it.

Automatic promotion remains available unless the customer enables the optional
environment gate. Configure either model using the
[self-hosted change-management procedure](../../../docs/compliance/soc2/self-hosted/procedures/change-management.md).

## Environment wiring

`values-dev.yaml` and `values-prod.yaml` carry **sizing and profile only**. The
account-bound values live outside the chart so one chart serves every cluster,
and are supplied at deploy time:

| Flag | Source |
| --- | --- |
| `global.siteUrl=http://<alb-hostname>` | **Non-TLS only.** The internet-facing ALB. With TLS this must stay unset — it takes precedence over `global.domain` and would break auth callbacks |
| `global.domain=<hostname>` | **TLS only.** The hostname on the ACM certificate. Becomes the Ingress host rule and the base of every auth callback, so there is no safe committed default |
| `global.region=<region>` | drives `S3_ENDPOINT` / `S3_REGION`; defaults to `us-east-1` regardless of where you deploy |
| `s3.buckets.<key>=<prefix>-<suffix>` | `terraform output -json s3_buckets`. All seven share one prefix (`modules/s3/main.tf`), so in CI a single `S3_BUCKET_PREFIX` derives them |
| `temporal.namespace=<namespace>.<account>` | Temporal Cloud → Namespaces |
| `temporal.address=<host>:7233` | optional — only when the namespace sits outside the region `values.yaml` defaults to |
| `serviceAccount.roleArn=<arn>` | `terraform output -raw app_irsa_role_arn` |
| `ingress.certificateArn=<arn>` | TLS deploys only |
| `networkPolicy.vpcCidr=<cidr>` | optional — narrows ALB→web ingress to the real VPC |

**Not in this list: `elasticache.endpoint`.** The chart defines the key but no
template reads it — `REDIS_URL` is delivered by ExternalSecrets from the
Terraform-managed `fabric/<env>/redis` secret, with the TLS scheme and AUTH
token. Setting it changes only the pod-restart checksum.

`ci/gitlab/60-deploy-aws.yml` passes all of these from GitLab CI/CD variables
(listed in `ci/gitlab/00-variables.yml`) and **hard-fails when a required one is
missing**, so a deploy cannot come up green against a bucket or namespace that
does not exist. Deploying by hand means passing the same flags yourself:

```bash
helm upgrade --install fabric . -f values-dev.yaml -n fabric --create-namespace \
  --set global.siteUrl="http://$WEB_ALB_HOSTNAME" \
  --set global.region="$AWS_REGION" \
  --set temporal.namespace="$TEMPORAL_NAMESPACE" \
  --set serviceAccount.roleArn="$APP_IRSA_ROLE_ARN" \
  --set s3.buckets.avatars="$S3_BUCKET_PREFIX-avatars" \
  --set s3.buckets.chatDocuments="$S3_BUCKET_PREFIX-chat-documents" \
  --set s3.buckets.projectContexts="$S3_BUCKET_PREFIX-project-contexts" \
  --set s3.buckets.workspaceDocuments="$S3_BUCKET_PREFIX-workspace-documents" \
  --set s3.buckets.orchestratorArtifacts="$S3_BUCKET_PREFIX-orchestrator-artifacts" \
  --set s3.buckets.skills="$S3_BUCKET_PREFIX-skills" \
  --set s3.buckets.projectDocumentAssets="$S3_BUCKET_PREFIX-project-document-assets" \
  --atomic --timeout 15m
```

For production — note `global.domain` is required, not optional. `values-prod.yaml`
sets `ingress.tls: true` but deliberately ships no domain, so omitting it yields
an Ingress with no host rule and an empty `NEXT_PUBLIC_SITE_URL`:

```bash
helm upgrade --install fabric . -f values-prod.yaml -n fabric \
  --set global.imageRegistry=123456789012.dkr.ecr.us-east-1.amazonaws.com \
  --set global.imageTag=$CI_COMMIT_SHA \
  --set global.domain="$PROD_DOMAIN" \
  --set global.region="$AWS_REGION" \
  --set ingress.certificateArn=arn:aws:acm:us-east-1:...:certificate/... \
  --set serviceAccount.roleArn="$APP_IRSA_ROLE_ARN" \
  --set temporal.namespace="$TEMPORAL_NAMESPACE" \
  --set s3.buckets.avatars="$S3_BUCKET_PREFIX-avatars" \
  --set s3.buckets.chatDocuments="$S3_BUCKET_PREFIX-chat-documents" \
  --set s3.buckets.projectContexts="$S3_BUCKET_PREFIX-project-contexts" \
  --set s3.buckets.workspaceDocuments="$S3_BUCKET_PREFIX-workspace-documents" \
  --set s3.buckets.orchestratorArtifacts="$S3_BUCKET_PREFIX-orchestrator-artifacts" \
  --set s3.buckets.skills="$S3_BUCKET_PREFIX-skills" \
  --set s3.buckets.projectDocumentAssets="$S3_BUCKET_PREFIX-project-document-assets" \
  --atomic --timeout 15m
```

> **`--set` and commas.** Both commands above use `--set` for readability, but
> `helm --set` treats an unescaped comma as an assignment separator and an IAM
> path may legally contain one — so a valid `serviceAccount.roleArn` can fail
> with `key "..." has no value`. `--set-string` does **not** help; it changes
> typing, not delimiter parsing. If your role ARN contains a comma, put that
> value in a file instead:
>
> ```bash
> printf 'serviceAccount:\n  roleArn: %s\n' "'$APP_IRSA_ROLE_ARN'" > /tmp/wiring.yaml
> helm upgrade ... -f /tmp/wiring.yaml   # drop the --set serviceAccount.roleArn flag
> ```
>
> This is why the CI job generates an override file rather than using `--set`.

## Uninstall

```bash
helm uninstall fabric -n fabric
```

`PersistentVolumeClaim` and `Secret` objects synced by External Secrets
Operator are **not** deleted automatically — clean them up explicitly if you
want a fresh slate.

## Values reference

| Key                  | Purpose                                                                 |
| -------------------- | ----------------------------------------------------------------------- |
| `global`             | Cross-cutting settings: image registry/tag, environment, domain, region |
| `ingress`            | ALB Ingress configuration (enabled, TLS on/off, ACM certificate ARN)    |
| `externalSecrets`    | ESO toggle, `ClusterSecretStore` name, refresh interval                 |
| `migrations`         | Pre-upgrade Prisma migration Job toggle                                 |
| `seed`               | Opt-in dev-data seeder Job (users, default org) — off by default        |
| `serviceAccount`     | Shared `fabric` ServiceAccount + IRSA role ARN                          |
| `web`                | Next.js app deployment (replicas, image, port, resources)               |
| `temporalWorker`     | Temporal worker deployment                                              |
| `mcpStdioWrapper`    | MCP stdio<>HTTP bridge deployment                                       |
| `agents`             | List of 11 LangGraph agent deployments (name, image, port, replicas)    |
| `customAgentRuntime` | Sandbox runtime for user-defined agents — disabled by default           |
| `qdrant`             | Self-hosted Qdrant vector DB (StatefulSet + EBS PVC): enable/disable, image, ports, storage size + storageClassName, resources, externalUrl for Qdrant Cloud |
| `otelCollector`      | OpenTelemetry Collector sidecar/daemonset toggle + exporter             |
| `fluentbit`          | Log forwarder toggle + destination                                      |
| `networkPolicy`      | Default-deny + per-service allow NetworkPolicies (prod-only by default) |
| `temporal`           | Temporal Cloud endpoint + namespace                                     |
| `collaboration`      | PartyKit (collab) host — set after PartyKit deploy                      |
| `elasticache`        | **Vestigial — no template reads it.** `REDIS_URL` arrives via ExternalSecrets from `fabric/<env>/redis` |
| `s3`                 | Per-feature S3 bucket names (all Terraform outputs)                     |
| `tags`               | Free-form tag map propagated onto AWS resources where supported         |

See `values.yaml` for the full default tree and `values-dev.yaml` /
`values-prod.yaml` for the supplied overrides.

## Further reading

For the full deploy guide — Terraform prerequisites, GitLab CI wiring,
secret bootstrap, day-2 operations — see
[`docs/deployment/AWS-DEPLOYMENT.md`](../../../docs/deployment/AWS-DEPLOYMENT.md)
(added by a later task in the AWS k8s deployment workstream).
