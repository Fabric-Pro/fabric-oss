---
"fabric-app": patch
---

Record the fourteen dependencies whose install scripts pnpm skips, silencing the "Ignored build scripts" warning on every install

pnpm 10 refuses to run dependency lifecycle scripts unless the package is in `onlyBuiltDependencies`, and warns once per install about every package it skipped that is in neither list. Fourteen packages fell in neither: the six `tree-sitter-*` grammars, `workerd`, `onnxruntime-node`, `@parcel/watcher`, `unrs-resolver`, `bufferutil`, `utf-8-validate`, `core-js` and `@scarf/scarf`.

None of them need their script on the platforms we install on. The tree-sitter grammars ship `prebuilds/<platform>` binaries that `node-gyp-build` finds at require time; `workerd` is a JS shim over the `@cloudflare/workerd-<platform>` package; `onnxruntime-node` ships its CPU binary and its postinstall only fetches optional GPU providers; `@parcel/watcher` and `unrs-resolver` get native code from platform-specific optional dependencies and only compile as a fallback; `bufferutil` and `utf-8-validate` are optional accelerators for `ws` with a pure-JS fallback; `core-js`'s postinstall prints a funding banner; `@scarf/scarf` is install-time telemetry. Listing them in `ignoredBuiltDependencies` records that decision instead of leaving the warning to be re-triaged. `pnpm approve-builds` was deliberately not used: it would move them into `onlyBuiltDependencies` and permit their lifecycle scripts to run on every install, which for the native ones means compiling whenever no prebuild matches.

No lockfile change: pnpm does not record either list in `pnpm-lock.yaml`.
