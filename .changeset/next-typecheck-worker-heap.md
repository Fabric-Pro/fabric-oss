---
"fabric-app": patch
---

Re-enable AVIF image optimization, and restore the web build's type-check heap

`next` 16.3.3 → 16.3.4. The 16.3.3 mitigation for the AVIF remote-code-execution advisory was to **disable AVIF optimization outright** — "until a fix has propagated, optimization of AVIF files is disabled". That fix has propagated: the underlying `libheif` flaw is in `sharp`, already patched to 0.35.4 in the same release, and 16.3.4 turns AVIF back on. Staying on 16.3.3 would have shipped image optimization silently degraded for that format.

The build also compiled fine and then died at 4,034 MB — Node's default heap — despite being launched with `--max-old-space-size=12288`. Next 16.3 runs the TypeScript phase in a child process, which inherits the environment but not the parent's argv, so the cap silently stopped applying to the one phase that needed it. `NODE_OPTIONS` is the form a child inherits.

Scoped to that one command rather than a Dockerfile-wide `ENV`, because the dependency build step above deliberately caps at 6144 — Vercel runs that same script, where a larger V8 heap risks the container OOM-killing the process instead.
