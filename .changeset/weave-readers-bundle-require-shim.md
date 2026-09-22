---
"fabric-app": patch
---

The weave-readers agent bundle loads again: it no longer fails at start-up with `Dynamic require of "process" is not supported` from an inlined CommonJS dependency, and a load-time smoke test now runs the built bundle so the same class of failure is caught before a container image is built.

The bundle defines `require` through `createRequire`, the same fix weave-planners already carries, instead of externalizing one dependency at a time. The backlog-updater `start` script also points at the entry its build actually produces.
