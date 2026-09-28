---
"fabric-app": patch
---

The Teams channel monitor now analyzes and captures replies posted to a thread after that thread was first analyzed, instead of ignoring them, and proposes backlog changes only for what the new replies add.

A revisited thread shows the analyzer its earlier messages as already-reviewed context, so replies that only acknowledge or restate the earlier discussion produce no proposal. Threads analyzed before this release are not re-analyzed unless they receive a new reply.
