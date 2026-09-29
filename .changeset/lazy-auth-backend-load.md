---
"fabric-app": patch
---

Load MCP seeding and Temporal account deletion modules only when their auth write hooks run, reducing server startup work for authenticated page reads.
