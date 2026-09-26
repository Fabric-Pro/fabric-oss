---
"fabric-app": patch
---

Azure DevOps connections now start in seconds, so hourly project-management polls no longer time out before reaching Azure DevOps.

Since the stdio wrapper started rejecting a failed initialize (2026-09-10), every ADO state poll cold-started `npx -y @azure-devops/mcp@2.8.0` for each connection at the top of the hour. On the wrapper's 0.5 vCPU, three or more concurrent npx starts took 30–40 s, past the 30 s initialize deadline, so the processes were killed and PM discovery failed with "Request timeout after 30000ms". Staging polls that saw any ADO item fell from ~25% to 5–7% of runs.

The wrapper now runs a catalog `npx` command from the package the image already installed globally when that installed copy is the one npx would run (unversioned spec, or an exact version equal to the installed one); tags, ranges and other versions still go through npx. The handshake with a freshly spawned server also gets a 120 s deadline instead of the 30 s request timeout; a server that exits still fails immediately.

Reproduced locally in the wrapper image at 0.5 vCPU / 1 GiB with staging's top-of-hour wave: current wrapper 3/4 calls fail at 30 s; pre-change wrapper 4/4 succeed in ~40 s; fixed wrapper 4/4 succeed in ~5 s, 8 concurrent in ≤16.4 s, and a non-preinstalled version succeeds in 37 s through npx.
