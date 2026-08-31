---
"fabric-app": patch
---

Stop the personal-context drop from taking global rows, and let its dry run report what it would take

A row with no organization AND no user is not personal context — it is global. The seeded MCP catalog and the system prompt library are exactly that shape, and a sweep written against `organizationId IS NULL` alone selected all of them: on a local database, seventy-two of the eighty-seven rows the inventory reported, including forty-six MCP servers and every system prompt, version and binding. The predicate now requires an owner wherever the schema allows a row without one, and both the inventory and the job read it from the same place, so they cannot disagree.

The dry run also stopped at the first phase's refusals and never reported the sweep at all — so the report an operator is told to read before applying accounted for no models. It stops only when applying now, which is where stopping is the point.

Found by reading the inventory before running anything, which is what the plan asks for and why it asks.
