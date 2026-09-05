---
"fabric-app": patch
---

Add Aspire dashboard commands to rebuild-and-restart each agent, run database seeds, and apply RLS policies (Fizzy #2373)

The AppHost had no `WithCommand` calls at all, so two routine local-dev chores each
needed a second terminal and a manual follow-up in the dashboard.

**Rebuild & restart** (11 LangGraph agent containers, dev mode only). The dev entrypoint
runs `if [ ! -f dist/<entry> ]; then pnpm build; fi`, so it only builds when the bundle
is missing — a source change needed a separate build followed by a container restart. The
command does both: it builds, streams every line into the resource's console log, and on
success invokes the resource's own `KnownResourceCommands.RestartCommand`. A non-zero exit
returns a failure carrying the last 40 lines of output. Enabled only while Running.

The build runs **inside** the container, not on the host. A host-side
`pnpm --filter <pkg> build` was the first implementation and fails on Linux with
`EACCES: permission denied, unlink .../dist/chunk-*.js`: the container's first-run build
executes as root against the bind-mounted checkout, so every agent's `dist/` is root-owned
in the working tree. The command instead resolves the container id via
`<runtime> ps -q --filter label=com.docker.compose.service=<resource> --filter name=^/?<instance-id>$ --filter status=running`
— the label the AppHost already stamps on every dev-mode agent container (the model
resource name) plus the container name, which is the Aspire instance id
`<resource>-<suffix>`. The label alone is not unique: a persistent container left behind
by another checkout of the repo carries the same label, so the lookup fails closed unless
exactly one container matches both filters. It then runs
`<runtime> exec <id> sh -c "corepack enable && cd /app/agents/langchain/<resource> && pnpm build"`,
which is exactly what the entrypoint does. The agent directory equals the Aspire resource
name for all 11, so no name mapping is needed. The runtime CLI honours
`DcpPublisher:ContainerRuntime` / `DOTNET_ASPIRE_CONTAINER_RUNTIME`, defaulting to docker.

One trap found at runtime: inside the execute callback `context.ResourceName` is the
runtime instance id (`task-planner-<suffix>`), not the model name. Keyed by that id,
`ResourceNotificationService.WaitForResourceAsync` never completes and the label lookup
finds nothing, so the helper captures `agent.Resource.Name` at definition time for the
label and the directory, and uses the instance id only to address the restart. Each phase
logs before it starts, so a future hang is visible in the console log.

`data-analyst` is deliberately excluded — it runs `pnpm exec tsx unified-server.ts` from
source, so a plain restart already suffices and there is no bundle to rebuild.

**Run seed** and **Apply RLS policies** on the `postgres` resource. The seed choices are
read from `packages/database/package.json` at app-host startup (every `^seed(:|$)` script,
minus the `:staging` / `:prod` variants, which load `.env.staging` / `.env.production` and
must never be reachable from a dashboard button). The submitted value is re-checked in
both `ValidateArguments` and the execute callback, since the CLI and MCP paths can post an
arbitrary string for a `Choice` argument. Both run on the host against whatever
`.env.local` resolves to, exactly as running the script from a terminal would.

Two Aspire API names differ from what the docs suggest: `ExecuteCommandContext.ServiceProvider`
and `ExecuteCommandResult.ErrorMessage` are `[Obsolete]` in 13.5.3, superseded by `.Services`
and `.Message` (using the old pair builds but emits CS0618).

Verified at runtime by restarting Aspire with the new AppHost and driving every command
over the Aspire MCP: `seed` with a `:prod` script is rejected by the Choice validation,
`seed:ai-models` and `apply-rls` run with their pnpm output in the postgres console log, and
`rebuild` on task-planner rewrites `dist/unified-server.js`, recreates the container and
comes back healthy. Also verified with `dotnet build aspire/Fabric.AppHost/Fabric.AppHost.csproj`: 0 errors, and the
only remaining warning (ASPIRE010, about the CLI bundle) is pre-existing. The seed and
apply-rls commands were exercised against a running app host — an invalid choice is
rejected, and `seed:ai-models` and `apply:rls` both succeeded. Docs added to
`docs/ASPIRE_USAGE.md` under Command Reference, including the MCP `execute_resource_command`
form.
