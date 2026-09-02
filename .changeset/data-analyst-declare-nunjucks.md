---
"fabric-app": patch
---

Fix the data-analyst agent crash-looping on startup with "Cannot find package 'nunjucks'" by declaring the dependency its bundle loads at runtime.

The agent's tsup config marks `nunjucks` external (it is CJS with a dynamic `require("events")` that esbuild cannot bundle into ESM), so `dist/unified-server.js` imports it from node_modules at runtime. The transitive source is `@repo/utils` → `template-renderer.ts`, which the bundle inlines. PR #2912's knip cleanup removed `nunjucks` from `agents/langchain/data-analyst/package.json` because nothing in the agent imports it directly; the next release (#2887, image `7891aa7e`, 2026-08-19) then failed every start with `ERR_MODULE_NOT_FOUND`, since pnpm's strict layout installs the package only under `packages/utils/node_modules`, which is not on the resolution path of the agent's dist directory. The container had zero healthy replicas from 2026-08-19 until this fix.

weave-readers already declares `nunjucks` for exactly this reason and carries a knip `ignoreDependencies` entry; data-analyst now does the same. `stripe` was removed by the same PR but is not imported by the built bundle (verified by scanning every bare specifier in `dist/*.js`), so it stays out.
