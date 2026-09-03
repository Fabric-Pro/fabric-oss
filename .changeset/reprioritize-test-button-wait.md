---
"fabric-app": patch
---

Give the Re-prioritize roadmap test a longer wait for its button, so a loaded CI runner is far less likely to fail it before the project query resolves.

The button renders only once `projects.get` resolves (`canEdit`), and the large-list case renders a hundred rows before waiting for it with Testing Library's 1s default. On the public mirror's Vitest job that default was outlasted (fabric-oss run 33738973241, relaying fabric-dev PR #160, which never touched this component) and the relay attempt was refused. The helper now waits up to 5s; nothing else about the tests changes.
