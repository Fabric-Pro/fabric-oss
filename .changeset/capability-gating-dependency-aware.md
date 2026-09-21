---
"fabric-app": patch
---

Setup-dependent actions now say what is missing and what would unlock them, instead of failing when pressed or quietly returning a worse answer.

One derived gating engine resolves every setup-dependent capability to one of six states — available, warning, soft block, hard block, processing, hidden — from live system state on each read. Nothing about a gate is stored, so it cannot drift from the project it describes. Composite prerequisites collapse to the strictest state and the message names the specific missing dependency rather than announcing a verdict.

The engine lives in its own module and deliberately never reads the project readiness checklist: the two answer different questions, and a snoozed reminder is not a satisfied dependency. A test reads the module's source text and fails the build if that boundary is ever crossed.

The correctness spine is a split predicate on the codebase. "May a dependent capability run" keys on the durable fact that an index once completed and its output survived; "is the connection healthy" keys on the latest run outcome and the integration's own status. A failed refresh over a surviving snapshot is therefore a warning rather than a block — collapsing the two would take Atlas away from projects whose graph is being served successfully at that moment, which is the regression this pattern has already cost twice elsewhere.

Enforcement is a fail-closed check at each mutating procedure, not only a disabled button: these procedures are reachable from coding agents, the public API and Fabric's own tools, so rendering alone would gate nothing. An expired credential and an unreachable repository are kept distinct and point at different remedies, because reconnecting cannot fix the second one.

Warning suppression is the one persisted thing — dismiss for this session, one, seven or thirty days, or not again for this project — scoped to the person and the project, fingerprinted over the durable dependency facts so it survives a reload but returns the moment the dependency materially changes. It can only ever hide a warning; every blocked or processing state refuses suppression at both the write and the read.

Project scans were the only background work in the product with no durable closer: an interrupted run sat as running forever with no sweep and no self-heal. They now come under the existing background-job watchdog, so an abandoned scan is corrected whether or not anyone opens the page.

Ships behind an organization-scopable flag, default off. Off reproduces today's behaviour exactly — no gate resolved, no refusal thrown — and stored suppressions are left untouched, so flipping it back on restores them.

Roadmap gating is deliberately not included: those requirements gate surfaces that are still being built, and they move into the cards that build them.
