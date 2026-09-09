---
"fabric-app": patch
---

Restore the web image build's type-check heap, which Next 16.3 stopped honouring

The build compiled fine and then died at 4,034 MB — Node's default heap — despite being launched with `--max-old-space-size=12288`. Next 16.3 runs the TypeScript phase in a child process, which inherits the environment but not the parent's argv, so the cap silently stopped applying to the one phase that needed it. `NODE_OPTIONS` is the form a child inherits.

Scoped to that one command rather than a Dockerfile-wide `ENV`, because the dependency build step above deliberately caps at 6144 — Vercel runs that same script, where a larger V8 heap risks the container OOM-killing the process instead.
