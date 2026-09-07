---
"fabric-app": patch
---

Run the dev-mode LangGraph agent containers on node:22-slim so in-container builds work against the host's node_modules and dist/ stays host-owned.

Fizzy #2428. The Aspire dashboard's "Rebuild & restart" command (and every agent's first-run build) ran `pnpm build` inside a `node:22-alpine` container that bind-mounts the host checkout, including the host's `node_modules`. pnpm installs only the current platform's native optional binaries, so the store holds `@rollup/rollup-linux-x64-gnu` and no musl variant, and tsup died on load with "Cannot find module @rollup/rollup-linux-x64-musl" before touching any source. The production Dockerfiles already build and run on `node:22-slim`, so dev and prod now agree on libc as well.

Second half of the same papercut: because the container runs as root, every in-container build left `dist/` root-owned on Linux, after which a host-side `pnpm --filter <name>-agent build` (tsup's `clean: true` cannot unlink the old chunks) failed with EACCES and had to be repaired with a manual `chown`. Three shell helpers are now prepended to every dev-mode entrypoint and to the rebuild command's `docker exec`: `fix_dist_owner` (Linux only: `chown -hR --reference=/app -- dist`), `build_agent` (`pnpm build`, then the handback whether or not the build succeeded, reporting a build failure ahead of a chown failure) and `ensure_agent_built <bundle>` (build when the bundle is missing, otherwise just repair ownership, so a `dist/` left root-owned by an older AppHost is fixed on the next start). macOS/Windows shadow `node_modules` with a Docker volume and map ownership through the file-sharing layer, so `fix_dist_owner` is a no-op there.

That volume is renamed from `fabric-linux-node-modules` to `fabric-glibc-node-modules`: the old one was populated by the alpine containers with musl binaries, and its `.linux-installed` marker would have made the slim containers skip the reinstall. The orphaned volume can be removed with `docker volume rm fabric-linux-node-modules`.

`aspire/Fabric.AppHost/Program.cs` only: 12 image tags, the shell helpers, the volume name, and the comments that claimed the host binaries were valid in an alpine container.
