# Fabric — Deployment Troubleshooting

Common failures, what they mean, and how to fix them. Organized by where the failure surfaces.

When something breaks, the right first step is almost always to look at `kubectl describe` or `kubectl logs` for the offending resource — most of the recipes below boil down to "do that, then interpret what you see."

## Contents

1. [Pipeline failures](#1-pipeline-failures)
2. [Pod failures](#2-pod-failures)
3. [Helm failures](#3-helm-failures)
4. [Networking issues](#4-networking-issues)
5. [External Secrets Operator](#5-external-secrets-operator)
6. [Terraform](#6-terraform)
7. [Migration discipline](#7-migration-discipline-expand-contract)

---

## 1. Pipeline failures

### 1.1 `AWS sts assume-role-with-web-identity` errors

**Symptom.** In a job extending `.aws_oidc`:

```
An error occurred (AccessDenied) when calling the AssumeRoleWithWebIdentity operation:
Not authorized to perform sts:AssumeRoleWithWebIdentity
```

**Cause.** The OIDC trust policy on `FabricDeployer` is scoped to a specific GitLab project path. Either:
- The job is running for a different project than the one in `gitlab_project_path`, or
- The trust policy's `gitlab.com:sub` matcher doesn't include the branch / MR ref the job is running on.

**Fix.**
1. Confirm the project path:
   ```bash
   terraform -chdir=deploy/terraform/environments/dev show -json | \
     jq '.values.root_module.child_modules[] | select(.address=="module.gitlab_oidc") | .resources[] | select(.type=="aws_iam_role")'
   ```
   The trust policy's `Condition.StringLike."gitlab.com:sub"` should look like `project_path:youruser/fabric-test:ref_type:branch:ref:*`.
2. If `gitlab_project_path` in `terraform.tfvars` doesn't match your actual GitLab project, fix it and `terraform apply`.
3. If you renamed the GitLab project (the path changed), re-apply Terraform.

### 1.2 `ECR push 403 / 401`

**Symptom.** Build job logs:

```
denied: User: arn:aws:sts::123456789012:assumed-role/FabricDeployer/gitlab-... is not authorized to perform: ecr:BatchCheckLayerAvailability
```

**Cause.** The `FabricDeployer` role's policy doesn't grant `ecr:*` on the right repository ARN — usually because `terraform apply` was run before the ECR module was applied, so the dynamic ARN list passed into `module.gitlab_oidc.ecr_arns` was empty.

**Fix.**
1. Re-run the Phase 2 `terraform apply`:
   ```bash
   cd deploy/terraform/environments/dev
   terraform apply
   ```
   Terraform will detect drift and re-attach the policy with the correct ARNs.
2. Verify:
   ```bash
   aws iam get-role-policy \
     --role-name FabricDeployer-fabric-dev \
     --policy-name fabric-dev-deployer-inline 2>/dev/null \
   | jq '.PolicyDocument.Statement[] | select(.Action[]? | startswith("ecr:"))'
   ```

### 1.3 `kubectl get pods` says `unauthorized`

**Symptom.** In a deploy or smoke job:

```
error: You must be logged in to the server (Unauthorized)
```

Or from your laptop after `aws eks update-kubeconfig`:

```
E0521 ... Unable to connect to the server: getting credentials: ...
```

**Cause.** EKS Access Entries (the modern replacement for the `aws-auth` ConfigMap) don't grant the IAM principal cluster-admin access.

**Fix.**
1. List existing access entries:
   ```bash
   aws eks list-access-entries --cluster-name fabric-dev --region us-east-1
   ```
2. For the FabricDeployer role + your own IAM user, you should see entries with `clusterAdmin` policy attached. If missing:
   ```bash
   ACCOUNT=$(aws sts get-caller-identity --query Account --output text)

   # Add your own IAM user
   aws eks create-access-entry \
     --cluster-name fabric-dev --region us-east-1 \
     --principal-arn "arn:aws:iam::$ACCOUNT:user/yourname"
   aws eks associate-access-policy \
     --cluster-name fabric-dev --region us-east-1 \
     --principal-arn "arn:aws:iam::$ACCOUNT:user/yourname" \
     --policy-arn "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy" \
     --access-scope type=cluster
   ```
3. The `eks` Terraform module already creates an access entry for the FabricDeployer role. If that's not what you see, re-apply.

### 1.4 Pipeline jobs pending forever — no runner available

**Symptom.** Jobs sit in `pending` status indefinitely. `glab ci status --live` shows `pending: waiting for runner`.

**Cause.** Either:
- The self-hosted runner isn't running (`module.gitlab_runner` not applied, or the Helm release crashed).
- The runner exists but its tags don't match the job's tag selector (`fabric-runner`).

**Fix.**
1. Check the runner pod:
   ```bash
   kubectl get pods -n gitlab-runner
   kubectl logs -n gitlab-runner deploy/gitlab-runner --tail=100
   ```
   Expect `Registering runner... succeeded`. If you see "401 Unauthorized", the authentication token (`gitlab_runner_token`) in `terraform.tfvars` is wrong or has been revoked.
2. In GitLab: project → Settings → CI/CD → Runners. You should see one runner with the `fabric-runner` tag and a green status indicator. If absent: the runner failed to register. If present but red: the runner pod stopped polling — check logs.
3. Issue a fresh runner authentication token (UI — same flow as bootstrap step 0.6), update `gitlab_runner_token` in `terraform.tfvars`, `terraform apply`.

### 1.5 Cloudflare deploy job fails with `Authentication error`

**Symptom.** `61-deploy-cloudflare.yml` logs:

```
✘ [ERROR] Failed to make POST request to https://api.cloudflare.com/...
Authentication error
```

**Cause.** Wrong `CLOUDFLARE_API_TOKEN` or insufficient permissions on it.

**Fix.**
1. The token needs **Account → Workers Scripts: Edit** and **Account → Account Settings: Read** at minimum. Add **Account → Workers R2 Storage: Edit** only if any worker uses R2.
2. The `Account resources` of the token must include the account ID matching `CLOUDFLARE_ACCOUNT_ID`.
3. Reissue the token in Cloudflare → My Profile → API Tokens, paste the new value into the GitLab CI variable.

The Cloudflare job is `allow_failure: true` in the pipeline, so the rest of the deploy proceeds even when this breaks. Don't ignore it indefinitely — PartyKit not deploying means real-time collaboration is broken.

---

## 2. Pod failures

### 2.1 `ImagePullBackOff`

**Symptom.**

```
$ kubectl get pods -n fabric
NAME                       READY   STATUS             RESTARTS   AGE
web-7d9f8b6c4-abc12        0/1     ImagePullBackOff   0          2m
```

`kubectl describe pod web-7d9f8b6c4-abc12 -n fabric` ends with something like:

```
Failed to pull image "123456789012.dkr.ecr.us-east-1.amazonaws.com/fabric-web:abc123":
  rpc error: code = Unknown desc = failed to authorize: ... no basic auth credentials
```

**Causes.**
- The node IAM role doesn't have `AmazonEC2ContainerRegistryReadOnly` attached (the `eks` module attaches it; if missing, re-apply).
- The image tag doesn't exist in ECR (`global.imageTag` mismatch between what was pushed and what Helm tried to deploy).
- The ECR repository is in a different region than `aws eks update-kubeconfig` configured.

**Fix.**
1. Verify the image exists:
   ```bash
   aws ecr describe-images \
     --repository-name fabric-web \
     --image-ids imageTag=abc123 --region us-east-1
   ```
2. Check the node role attachments:
   ```bash
   NODE_ROLE=$(aws eks describe-nodegroup \
     --cluster-name fabric-dev --nodegroup-name fabric-dev-ng \
     --query 'nodegroup.nodeRole' --output text | awk -F/ '{print $NF}')
   aws iam list-attached-role-policies --role-name "$NODE_ROLE"
   ```
   You should see `AmazonEC2ContainerRegistryReadOnly` (and `AmazonEKSWorkerNodePolicy`, `AmazonEKS_CNI_Policy`).

### 2.2 `CrashLoopBackOff`

**Symptom.**

```
$ kubectl get pods -n fabric
NAME                       READY   STATUS             RESTARTS   AGE
web-7d9f8b6c4-abc12        0/1     CrashLoopBackOff   5          4m
```

**Diagnosis.** Always check logs first:

```bash
kubectl logs -n fabric deploy/web --tail=200
kubectl logs -n fabric deploy/web --previous --tail=200   # if the current pod has restarted
```

**Common causes & fixes.**

| Log signature | Likely cause | Fix |
|---|---|---|
| `Missing environment variable: ANTHROPIC_API_KEY` / similar | ExternalSecret not synced | See §5 |
| `connect ECONNREFUSED` to RDS endpoint | RDS SG not allowing EKS SG, or `DATABASE_URL` malformed | Verify the RDS SG allows ingress from `module.eks.node_security_group_id` on 5432 (NOT the cluster/control-plane SG — pods egress from the node ENIs). Check `kubectl get secret fabric-app-secrets -n fabric -o json \| jq '.data.DATABASE_URL \| @base64d'` looks right. |
| `Error: P1001: Can't reach database server` | Same as above, Prisma-specific | Same fix. |
| `no pg_hba.conf entry for host ..., no encryption` (SQLSTATE 28000) | App/migrate use node-postgres which defaults to no SSL; RDS rejects unencrypted connections | Ensure `PGSSLMODE=no-verify` is set (chart configmap + migrate Job already do this). Prod follow-up: switch to verify-full + RDS CA bundle. |
| `Invalid better-auth secret` | `BETTER_AUTH_SECRET` is empty | The `auth` Secrets Manager group is empty or doesn't have that key. Re-run the `put-secret-value` for that group. |
| `Cannot find module @repo/database` | Migrate Job ran the wrong image | The migrate Job must use the `temporal-worker` image (it ships the workspace). Check `kubectl get job/fabric-migrate-XXX -n fabric -o yaml` — the container image. |
| Pod log mentions `wrong tag/digest` | `global.imageTag` mismatch | Confirm CI's `$CI_COMMIT_SHA` and the helm release's resolved tag match. |

> **temporal-worker has no readiness probe** (only a `pgrep` liveness check) — a bad Temporal Cloud connection can crash-loop silently while `helm --wait` and smoke tests still report success. Always check `kubectl logs -n fabric deploy/temporal-worker` after a deploy. The worker reads the API key from env var `TEMPORAL_CLOUD_API_KEY` (`packages/temporal/src/client.ts:21`); a wrong/empty value is a common cause.

### 2.3 `Pending` — no node capacity

**Symptom.**

```
$ kubectl get pods -n fabric
NAME                       READY   STATUS    RESTARTS   AGE
task-planner-xxx           0/1     Pending   0          3m
```

`kubectl describe pod task-planner-xxx -n fabric` ends with:

```
Events:
  Warning  FailedScheduling  ... 0/3 nodes are available: 3 Insufficient cpu.
```

> **Note.** The weave agents (`weave-readers`/`weave-shuttle`/`weave-planners`) and `fluentbit` are disabled in the dev profile (`values-dev.yaml:44-57,71-75`), so a missing weave Service is expected — not a scheduling failure.

**Cause.** Sum of pod CPU/memory requests exceeds what the nodes have. The dev node group is 2 × t3.large (2 vCPU / node = 4 vCPU = 4000m total, scalable 2–4) with 40Gi root volumes — see `deploy/terraform/environments/dev/main.tf:64-67`. The dev profile runs ~12 pods (web + temporal-worker + mcp-stdio-wrapper + qdrant + 8 agents) at ~50m each ≈ 600m, plus `web`/`temporal-worker` at higher requests and the DaemonSets (~200m); you're still comfortably under 4000m, so this shouldn't happen unless someone increased a request without increasing node capacity.

**Fix options.**
- Reduce requests in `values-dev.yaml`.
- Scale the node group via `aws eks update-nodegroup-config` (or edit the EKS module's `desired_size`).
- Add Karpenter / Cluster Autoscaler (not in MVP).

### 2.4 Migrate Job init container failed

**Symptom.** The pre-upgrade hook Job fails:

```
$ kubectl get jobs -n fabric
NAME                COMPLETIONS   DURATION   AGE
fabric-migrate-XXX  0/1           45s        45s
```

`helm upgrade --atomic` then rolls back the entire release.

**Diagnosis.**

```bash
kubectl logs -n fabric job/fabric-migrate-XXX
```

**Common causes & fixes.**

| Log signature | Cause | Fix |
|---|---|---|
| `Environment variable not found: DATABASE_URL` | `aws_secretsmanager_secret_version.database` didn't apply | `terraform apply -target=aws_secretsmanager_secret_version.database` |
| `Error: P3009: migrate found failed migrations in the target database` | Previous failed migration left the DB in a bad state | `kubectl exec -it deploy/temporal-worker -n fabric -- pnpm --filter @repo/database exec prisma migrate resolve --rolled-back <name> --schema=./prisma/schema.prisma` then re-deploy |
| `Schema engine error: column does not exist` | A migration assumes a column from a later migration | Migrations were applied out of order. `prisma migrate status` to inspect, then `migrate resolve` selectively. |
| `Connection terminated unexpectedly` | DB is mid-failover (multi-AZ) or restart | Wait 60s, re-run the deploy. |

---

## 3. Helm failures

### 3.1 `helm upgrade --atomic` rolled back

**Symptom.** The deploy job fails after timing out:

```
Error: UPGRADE FAILED: release fabric failed, and has been rolled back due to atomic being set:
  timed out waiting for the condition
```

**What happened.** `--atomic` deletes the new ReplicaSets and reverts to the previous release. The pods that *did* run during the failed upgrade are still in the cluster's history — you can still inspect them.

**Diagnosis.**

```bash
# Pods are GONE (rolled back), but events are still there for ~1 hour
kubectl get events -n fabric --sort-by=.lastTimestamp | tail -30

# Or look at the failed Job (migrate hook) which is preserved
kubectl get jobs -n fabric
kubectl logs job/fabric-migrate-XXX -n fabric
```

**Fix.** Find the reason a pod went unhealthy (or a Job failed), fix it, push, retry the deploy.

### 3.2 Finding the last good revision

```bash
helm history fabric -n fabric
```

Shows revision number, status (`deployed`, `superseded`, `failed`), date, and chart version.

### 3.3 Manual rollback

```bash
helm rollback fabric <REVISION> -n fabric --wait --timeout 10m
```

This re-applies the manifest set from `<REVISION>`. The migrate hook does NOT run on rollback (Helm hooks fire only on the install/upgrade/delete that you name) — so the database schema stays at whatever forward migration the failed deploy applied. See §7 on migration discipline.

### 3.4 Stuck in `pending-upgrade`

**Symptom.** `helm status fabric -n fabric` shows status `pending-upgrade` indefinitely.

**Cause.** A previous helm command was interrupted (Ctrl-C, network drop, CI job timeout) and didn't release the release lock.

**Fix.**

```bash
helm rollback fabric -n fabric                    # back to the last good revision
# OR
helm history fabric -n fabric                     # find the last "deployed" revision
helm rollback fabric <last-good-rev> -n fabric
```

If even rollback hangs, the `release-name-config` Secret (Helm v3 stores release state in Secrets named `sh.helm.release.v1.<release>.v<rev>`) can be edited:

```bash
kubectl get secrets -n fabric -l owner=helm,name=fabric
kubectl edit secret sh.helm.release.v1.fabric.v<rev> -n fabric
# Decode the release data, fix the status, re-encode. Only as a last resort.
```

---

## 4. Networking issues

### 4.1 Ingress has no `ADDRESS`

**Symptom.**

```
$ kubectl get ingress fabric-web -n fabric
NAME         CLASS  HOSTS   ADDRESS   PORTS   AGE
fabric-web   alb    *                  80      3m
```

The `ADDRESS` column stays empty.

**Cause.** The AWS Load Balancer Controller didn't realize the Ingress as an ALB. Reasons:
- The controller pod is crashed or not running.
- The Ingress is missing required annotations.
- The VPC subnets are missing the `kubernetes.io/role/elb=1` tag (the `vpc` module already adds it for public subnets and `kubernetes.io/role/internal-elb=1` for private; if missing, re-apply).

**Diagnosis.**

```bash
kubectl logs -n kube-system -l app.kubernetes.io/name=aws-load-balancer-controller --tail=200
```

Common log signatures:

| Signature | Cause | Fix |
|---|---|---|
| `failed to discover subnets` | Subnets missing `kubernetes.io/role/elb` tag | Re-run `terraform apply -target=module.vpc`. |
| `User: arn:aws:sts::...:assumed-role/... is not authorized to perform: elasticloadbalancing:CreateLoadBalancer` | Controller's IRSA role missing ELB permissions | `terraform apply -target=module.alb_controller`. |
| `WebIdentityErr: Couldn't retrieve credentials` | IRSA role association broken | `kubectl describe sa aws-load-balancer-controller -n kube-system` — check `eks.amazonaws.com/role-arn` annotation. |

### 4.2 OAuth redirect fails — `redirect_uri_mismatch`

**Symptom.** After clicking "Sign in with Google", you land on a Google error page: `Error 400: redirect_uri_mismatch`.

**Cause.** The redirect URI presented by the web app doesn't match any URI registered at the OAuth provider.

**Common cases.**
- HTTP-only deploy (no domain) and you registered `https://...` — switch the provider to the `http://<alb-host>/api/auth/callback/google` URL.
- HTTPS deploy and you forgot to update the URI after the cutover.
- The ALB hostname changed (e.g. you destroyed + re-created) and the old URI is stale.
- Subtle issues: trailing slash, port number, `www` prefix.

**Fix.** At the OAuth provider, edit the registered redirect URI to match exactly what's now in `NEXT_PUBLIC_SITE_URL` (or the ALB hostname). It can take a few minutes for OAuth provider changes to propagate.

### 4.3 Inter-service DNS not resolving

**Symptom.** A pod logs:

```
Error: getaddrinfo ENOTFOUND task-planner.fabric.svc.cluster.local
```

**Causes.**
- The agent Service doesn't exist (Helm release wasn't deployed, or `agents[].enabled: false`).
- CoreDNS isn't running.

**Fix.**

```bash
kubectl get svc -n fabric                       # confirm task-planner Service exists
kubectl get pods -n kube-system -l k8s-app=kube-dns  # confirm CoreDNS pods are Running

# Test from inside the cluster
kubectl run -it --rm -n fabric --image=busybox dns-test -- nslookup task-planner.fabric.svc.cluster.local
```

If CoreDNS pods are running but resolution fails, check `kubectl logs -n kube-system deploy/coredns` for upstream resolver errors.

### 4.4 Cluster outbound HTTPS fails (Anthropic / OpenAI / etc.)

**Symptom.** Web or agent pods log connection timeouts to external HTTPS endpoints.

**Causes.**
- NAT GW is unhealthy.
- The pod's outbound traffic doesn't have a default route to the NAT GW (private subnet route table misconfigured).

**Fix.**

```bash
# From inside the cluster
kubectl run -it --rm -n fabric --image=curlimages/curl curl-test -- \
  curl -v https://api.anthropic.com/v1 -m 5

aws ec2 describe-nat-gateways --region us-east-1 \
  --query 'NatGateways[?State!=`deleted`].[NatGatewayId,State]'
```

A `State: failed` NAT GW must be replaced. Terraform handles this on next apply; manually you can delete the failed one and let Terraform re-create.

---

## 5. External Secrets Operator

### 5.1 `ExternalSecret` not Ready

**Symptom.**

```
$ kubectl get externalsecret -n fabric
NAME                 STORE                READY   STATUS
fabric-app-secrets   aws-secrets-manager  False   SecretSyncedError
```

**Diagnosis.**

```bash
kubectl describe externalsecret fabric-app-secrets -n fabric
```

**Common causes & fixes.**

| Condition message | Cause | Fix |
|---|---|---|
| `secret not found: fabric/dev/<group>` | One of the 14 secret groups is missing | `aws secretsmanager describe-secret --secret-id fabric/dev/<group>` to verify. If missing, re-run `terraform apply -target=module.secrets`. |
| `AccessDenied: User ... is not authorized to perform: secretsmanager:GetSecretValue` | ESO controller's IRSA role missing permissions on that secret ARN | `terraform apply -target=module.external_secrets` re-attaches the policy. |
| `unable to retrieve token for sa` | IRSA SA token isn't being issued | `kubectl describe sa external-secrets -n external-secrets` — confirm `eks.amazonaws.com/role-arn` annotation; restart the controller pod: `kubectl rollout restart deploy/external-secrets -n external-secrets`. |
| `extract: invalid JSON` | The secret's `SecretString` isn't valid JSON | Open the secret in the AWS console; one of the `put-secret-value` commands wasn't a valid JSON object. Fix and re-run. |

### 5.2 Pod doesn't see the env var

**Symptom.** ExternalSecret is `Ready=True`, but a pod logs:

```
process.env.ANTHROPIC_API_KEY is undefined
```

**Cause.** Case-sensitive key mismatch in the Secrets Manager JSON. ESO projects keys verbatim — `Anthropic_api_key` becomes `Anthropic_api_key` env var, not `ANTHROPIC_API_KEY`.

**Fix.** Get the rendered Secret and inspect:

```bash
kubectl get secret fabric-app-secrets -n fabric -o json | jq '.data | keys'
```

The list should include `ANTHROPIC_API_KEY` (uppercase, underscore). If you see `anthropic_api_key` or `AnthropicApiKey`, rewrite the Secrets Manager JSON with the canonical name and force a re-sync:

```bash
kubectl annotate externalsecret/fabric-app-secrets force-sync=$(date +%s) -n fabric --overwrite
kubectl rollout restart deployment/web -n fabric
```

### 5.3 Force a re-sync

The `refreshInterval` in `values.yaml` defaults to `1h`. After an out-of-band edit (CLI `put-secret-value`), you can either wait for the interval, restart the controller, or annotate the ExternalSecret:

```bash
kubectl annotate externalsecret/fabric-app-secrets force-sync=$(date +%s) -n fabric --overwrite
```

The annotation change triggers an immediate reconcile.

### 5.4 Secret has stale values after Terraform overwrites `fabric/dev/database`

This **should not happen** because the resource has `ignore_changes = [secret_string]`. If it does:

1. Verify the lifecycle block exists in `environments/dev/main.tf`:
   ```hcl
   resource "aws_secretsmanager_secret_version" "database" {
     ...
     lifecycle {
       ignore_changes = [secret_string]
     }
   }
   ```
2. If it does and Terraform still wants to revert it, you might have edited the underlying database password manually (in the RDS console). `terraform refresh && terraform plan` will show what's changing.

---

## 6. Terraform

### 6.1 `Provider configuration not present`

**Symptom.** Phase 2 of the apply (the unrestricted `terraform apply`) errors:

```
Error: Provider configuration not present
```

Or, more commonly, a generic plan error referencing an "unknown value" in the `helm` or `kubernetes` provider config.

**Cause.** The providers reference `module.eks.cluster_endpoint`, which can't be resolved at plan time if the cluster wasn't fully created in Phase 1.

**Fix.**

```bash
terraform init -upgrade
terraform apply -target=module.eks       # confirm EKS is up
terraform apply                          # try again
```

### 6.2 State lock errors

**Symptom.**

```
Error: Error acquiring the state lock
  Lock Info:
    ID:        ...
    Path:      fabric-tfstate-...:dev/terraform.tfstate
    Operation: OperationTypeApply
    Who:       you@host
    Created:   2026-05-21 14:23:10 ...
```

**Cause.** Someone else has the lock (legitimate concurrent apply), OR a previous apply was killed and the lock wasn't released.

**Fix.**
1. Confirm nobody else is applying. Check Slack / your team / CI.
2. If you're sure it's stale, find the lock ID in the error and:
   ```bash
   terraform force-unlock <LOCK-ID>
   ```
   Type `yes` to confirm.

### 6.3 `terraform destroy` hangs on RDS

**Symptom.** Destroy progresses, then sits on `module.rds.aws_db_instance.this: Still destroying...` for many minutes.

**Causes.**
- `deletion_protection = true` (the dev module sets it to `false`, but if you copy/pasted to prod...).
- A final snapshot is being taken (`skip_final_snapshot = true` skips this in dev).

**Fix.**
```bash
# Check status
aws rds describe-db-instances --db-instance-identifier fabric-dev-pg \
  --query 'DBInstances[0].[DBInstanceStatus,DeletionProtection]' --output table
```

If `DeletionProtection` is `True`:

```bash
aws rds modify-db-instance \
  --db-instance-identifier fabric-dev-pg \
  --no-deletion-protection --apply-immediately
```

Then re-run `terraform destroy`.

### 6.4 `terraform destroy` hangs on S3

**Symptom.** Destroy hangs on `module.s3.aws_s3_bucket.this[...]: Still destroying...`.

**Cause.** Buckets have objects, especially versioned objects. `force_destroy = true` should handle this; if it's set to `false` somewhere it won't.

**Fix.**

```bash
# Confirm force_destroy in the module call
grep force_destroy deploy/terraform/environments/dev/main.tf
# Should be: force_destroy = true

# If for some reason that didn't propagate, empty the buckets manually
for B in $(aws s3 ls | awk '/fabric-dev/ {print $3}'); do
  aws s3 rm "s3://$B" --recursive
  aws s3api delete-objects --bucket "$B" --delete "$(aws s3api list-object-versions \
    --bucket "$B" --query='{Objects: Versions[].{Key:Key,VersionId:VersionId}}')" 2>/dev/null || true
done
```

Then re-run destroy.

### 6.5 KMS deletion blocked

**Symptom.**

```
Error: deleting KMS Alias (alias/fabric-eks): KMSInvalidStateException:
  CMK is not enabled for AWS resource
```

Or destroy succeeds but `aws kms list-keys` still shows your keys.

**Cause.** KMS keys have a recovery window. Dev sets `recovery_window_in_days = 0` for the Secrets Manager module, but the per-service KMS keys created by `module.kms` have AWS's default 30-day window.

**Fix.** For dev, this is acceptable — the keys stop being billed but persist. If you genuinely want them gone, schedule deletion manually:

```bash
for K in $(aws kms list-keys --query 'Keys[].KeyId' --output text); do
  ALIAS=$(aws kms list-aliases --key-id "$K" --query 'Aliases[0].AliasName' --output text 2>/dev/null)
  case "$ALIAS" in
    alias/fabric*)
      echo "Scheduling deletion of $K ($ALIAS)..."
      aws kms schedule-key-deletion --key-id "$K" --pending-window-in-days 7
      ;;
  esac
done
```

7 days is the minimum window AWS allows.

---

## 7. Migration discipline (expand-contract)

The Helm chart runs Prisma migrations as a **pre-upgrade hook** — the migrate Job completes before any Deployment rollout begins. Until the rolling update finishes, both the old code and the new code are running simultaneously, with the new schema. This means:

> **The OLD code must be compatible with the NEW schema for the duration of the rollout.**

The standard discipline is "expand-then-contract":

### 7.1 Safe migrations (single-PR)

These don't break old code:

- Add a nullable column.
- Add a new table.
- Add an index (use `CREATE INDEX CONCURRENTLY` in raw SQL migrations to avoid locking).
- Add a unique constraint *if* you're confident the existing data already satisfies it (otherwise the migration will fail loudly mid-deploy, which is the safer failure mode but still requires a fix-forward).
- Set a default value on a column (Postgres handles this without table rewrite for fixed defaults).

### 7.2 Risky migrations (require expand-then-contract, two PRs)

These break old code if applied in one shot:

- **Drop a column.** Old code may still write to it. → Expand: stop writing to it. Deploy. Then contract: drop in a follow-up.
- **Rename a column.** → Expand: add new column, dual-write (both names). Deploy. Backfill new column. Then contract: stop writing to old, drop old column.
- **Change a column's type.** Same dual-write pattern.
- **Add a NOT NULL column without a default.** → Expand: add nullable, backfill via app code or one-off script. Then contract: add NOT NULL constraint.
- **Drop a table** that the old code still SELECTs from. → Expand: stop reading. Deploy. Then contract: drop.

### 7.3 What happens if you ship a risky migration anyway

The migrate hook applies the schema change. The new pods roll out, work fine. The OLD pods — still running until the rollout finishes — start hitting the schema mismatch. Symptoms vary:

- `column "old_name" does not exist` — old code SELECTed a renamed column.
- 500 errors on writes — old code INSERTed into a dropped column.
- Constraint violation errors — old code inserted a value that violates a new NOT NULL.

The rolling update doesn't roll back automatically because the *new* pods are healthy. The old pods just produce errors until they're terminated by the deployment progressing.

### 7.4 If you got it wrong

1. **Don't `helm rollback`** unless you're certain the migration is reversible. Prisma migrations are forward-only unless you wrote an explicit down migration. A rollback redeploys the OLD code; if the schema has moved on, the old code now also fails — you've just made the outage symmetric.
2. Instead, **fix forward**: deploy a compatible-with-new-schema version of the code, push, let the pipeline roll out.
3. If the migration itself was a mistake (e.g. dropped a column you still needed), write a new forward migration that re-creates the column (or table), deploy, restore data from the most recent backup if necessary.

### 7.5 Catching this before it ships

The `prisma migrate dev` command run during development warns about destructive changes. Reading those warnings carefully is the cheapest insurance.

For higher-stakes deploys (production), add a manual gate in the pipeline: after `migrate` renders the manifest, require approval before `deploy-aws`. The MVP pipeline runs straight through; add a `when: manual` to the `deploy-aws` job in your fork if you want this.

---

## What's not covered here

- Application-level bugs (write a focused report with `kubectl logs ...` and search the codebase).
- Performance issues (Prometheus + Grafana setup is in `docs/monitoring/`, separately).
- Auth-specific failures (Better Auth has its own docs at `docs/audit-log/` for the audit side).
- Tenant isolation issues (see `docs/adr/003-xor-tenant-isolation.md`).
- Anything that's actually a code bug, not a deployment problem.

If you hit a recurring deployment failure not listed above and the fix is non-obvious, **add a row to this document**. Future-you will be grateful.
