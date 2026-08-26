# PartyKit — Real-Time Collaboration Deployment

PartyKit powers Fabric's live document co-editing (Yjs CRDT sync over WebSockets).
It supports three deployment modes. Mode A is the SaaS default; modes B and C exist
for self-hosted / enterprise deployments that cannot depend on
Cloudflare. See Fizzy #1722.

| Mode | When | Cloudflare needed? |
|------|------|--------------------|
| **A. Cloudflare-hosted** | SaaS / Fabric-hosted (default) | Yes |
| **B. Kubernetes self-hosted** | Enterprise, no external egress | No |
| **C. Disabled** | Customer doesn't need collaboration | No |

The switch is entirely environment-driven — no code changes between modes:

- `NEXT_PUBLIC_ENABLE_COLLABORATION` — `"true"` to enable collaboration, `"false"` to disable (mode C).
- `NEXT_PUBLIC_PARTYKIT_HOST` — **bare** `host[:port]`, **no scheme** (the client adds the WebSocket scheme, `ws`/`wss`, automatically).
  Point it at the Cloudflare Workers host (mode A) or the in-cluster ingress host (mode B).

Configuration is validated at web-app startup (`apps/web/modules/shared/lib/partykit-config.ts`):
a scheme-prefixed host fails fast everywhere; a missing host when collaboration is
enabled is a hard error in production and a warning in development.

---

## Mode A — Cloudflare-hosted (default)

Unchanged from the existing SaaS setup. The `party-cf` Worker is deployed via
`wrangler deploy` (`.github/workflows/deploy-partykit-prod.yml` / GitLab
`61-deploy-cloudflare`); the resulting `*.workers.dev` host is fed into
`collaboration.partykitHost`. See [EXTERNAL-SERVICES.md](./EXTERNAL-SERVICES.md#cloudflare).

Helm:
```yaml
collaboration:
  enabled: true
  partykitHost: "fabric-collab-prod.<account>.workers.dev"
partykit:
  enabled: false   # no in-cluster server
```

---

## Mode B — Kubernetes self-hosted

Runs the **same** `party-cf` server under the workerd runtime inside your cluster,
so no traffic leaves for Cloudflare. Ships as a StatefulSet with a per-pod
PersistentVolume for the Yjs document state (Durable Object SQLite storage).

### 1. Build and push the image
```bash
cd party-cf
docker build -t <registry>/fabric-partykit-selfhost:<tag> .
docker push <registry>/fabric-partykit-selfhost:<tag>
```
The container runs `party-cf` under workerd via `wrangler`, persists Durable Object
storage to `/data`, and bridges `PARTYKIT_ENV` / `FABRIC_API_URL` /
`AGENT_SERVICE_SECRET` from the pod environment into the worker at startup
(`party-cf/docker-entrypoint.sh`).

### 2. Helm values
```yaml
collaboration:
  enabled: true
  partykitHost: "partykit.fabric.example.com"   # = partykit.ingress.host below

partykit:
  enabled: true
  replicas: 1                       # see HA note
  image:
    repository: <registry>/fabric-partykit-selfhost
    tag: "<tag>"
  storage:
    size: 5Gi
    storageClassName: ""            # cluster default (gp3 via EBS CSI)
  ingress:
    enabled: true
    host: "partykit.fabric.example.com"
    tls: true
    certificateArn: "arn:aws:acm:...:certificate/..."
```
`AGENT_SERVICE_SECRET` must exist in the `fabric-app-secrets` Secret (same value the
web app and Temporal worker use). The server authorizes browser connections by
calling `FABRIC_API_URL/api/collab/verify` (wired to the in-cluster `web` Service).

### 3. Why a public ingress
Browsers connect **directly** to `NEXT_PUBLIC_PARTYKIT_HOST`, so PartyKit needs a
public, TLS-terminated ingress (unlike purely in-cluster services). ALB carries
WebSockets natively; the template raises the ALB idle timeout to 3600s so
long-lived collaboration sockets aren't dropped.

### 4. Minimum resources
Per pod (from the values defaults, sufficient for enterprise-scale concurrency):
requests `100m` CPU / `256Mi`, limits `500m` CPU / `512Mi`. Storage `5Gi` holds the
document snapshots. Re-benchmark for high concurrency before raising limits.

### 5. High availability — read this before scaling
The default **`replicas: 1`** is **restart-tolerant, single-active**: on pod restart
or reschedule, editors reconnect and resync from the persisted snapshot — a brief
per-room blip, no data loss. This was verified end-to-end (workerd container +
persistence across restart).

**Do not set `replicas > 1` with the ALB ingress.** Yjs requires all editors of a
document to reach the *same* pod; correct multi-replica operation needs sticky
routing by room (hash the `/parties/main/<room>` path to a stable pod). **AWS ALB
cannot hash by URL path.** True multi-replica HA therefore requires either:

- an **nginx ingress** with `nginx.ingress.kubernetes.io/upstream-hash-by: "$uri"`
  (each room pinned to one pod; different rooms spread across pods), or
- migrating collaboration to a **Redis-backed backend (Hocuspocus)** where any pod
  can serve any room (active-active, clean failover) — a larger change tracked
  separately.

Choose based on your availability bar: single-active + fast restart is adequate for
most self-hosted deployments; zero-downtime active-active needs the Redis path.

### 6. Verify
```bash
kubectl get statefulset,svc,ingress -l app.kubernetes.io/name=partykit
curl https://partykit.fabric.example.com/health      # {"status":"healthy",...}
```
Then open the same document in two browsers and confirm edits and cursors sync live.

---

## Mode C — Disabled (no PartyKit)

For deployments that don't need real-time collaboration:
```yaml
collaboration:
  enabled: false     # -> NEXT_PUBLIC_ENABLE_COLLABORATION=false
partykit:
  enabled: false
```
The app starts cleanly with no PartyKit configured. The document editor runs in
non-collaborative mode: collaboration UI/extensions are gated off, and if a stale
host is ever set, a 12s connection timeout falls back to non-collaborative editing
without blocking Save/Version actions. No PartyKit server, ingress, or storage is
provisioned.

---

## Environment variables (reference)

| Variable | Where | Notes |
|----------|-------|-------|
| `NEXT_PUBLIC_ENABLE_COLLABORATION` | ConfigMap (`collaboration.enabled`) | `"true"`/`"false"` |
| `NEXT_PUBLIC_PARTYKIT_HOST` | ConfigMap (`collaboration.partykitHost`) | bare `host[:port]`, no scheme |
| `COLLAB_JWT_SECRET` | Secret | web app mints collab access tokens |
| `AGENT_SERVICE_SECRET` | Secret | authorizes the Temporal → PartyKit publish path; also read by the self-hosted server |
| `FABRIC_API_URL` | ConfigMap | self-hosted server calls `…/api/collab/verify` |
