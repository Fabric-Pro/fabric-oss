# Self-hosted PartyKit (Fabric real-time collaboration) — Cloudflare-free container.
#
# Runs the SAME prod server (src/) under the workerd runtime via wrangler, so no
# code changes are needed vs the Cloudflare Workers deployment. Durable Object
# SQLite storage is persisted to /data — mount a PersistentVolume there.
#
# Path A (self-host) requires sticky routing by room at the ingress: all clients
# of a given document must reach the same pod. See deploy/helm/fabric and
# docs/deployment for the Kubernetes topology (StatefulSet + per-pod PVC +
# session affinity hashed on the /parties/main/<room> path).
#
# NOTE: wrangler runs workerd under the hood (same runtime Cloudflare runs in
# production). A future hardening is to run `workerd` directly from a bundled
# build; tracked as a follow-up. This mirrors the existing docker-compose
# `party/` service which runs `partykit dev` in a container.

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json ./
# Full install (wrangler lives in devDependencies and is needed at runtime).
RUN npm install --no-audit --no-fund

FROM node:22-slim
WORKDIR /app
ENV PARTYKIT_ENV=production
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json wrangler.toml tsconfig.json ./
COPY src ./src
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

# Durable Object SQLite storage lives here; mount a PVC at /data in Kubernetes.
# Grant the built-in non-root `node` user write access to the app dir (the
# entrypoint writes .dev.vars and wrangler writes its local state) and /data.
RUN mkdir -p /data && chown -R node:node /app /data
VOLUME ["/data"]

EXPOSE 1999

# Run as the non-root `node` user (SOC 2 / non-root container requirement).
USER node

# The entrypoint bridges FABRIC_API_URL / AGENT_SERVICE_SECRET / PARTYKIT_ENV
# (container env, supplied at deploy time) into workerd `env` bindings, then runs
# the server under workerd (--ip 0.0.0.0 for in-cluster reachability,
# --persist-to /data to keep DO storage on the mounted volume across restarts).
ENTRYPOINT ["./docker-entrypoint.sh"]
