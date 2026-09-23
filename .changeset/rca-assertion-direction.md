---
"fabric-app": patch
---

Test-failure analysis and bugs filed from failures now read expected vs actual correctly and never state a firmer cause than the analysis did.

`node:assert/strict` prints the ACTUAL value first — `90 !== 80` means the test wanted 80 and got 90 — and the failure analysis was reading that backwards, telling the reader the test "expects 90 but the discount logic produced 80". A new deterministic parser (`parseAssertionValues`, covering Node's assert output, Jest/Vitest, JUnit/Java, AssertJ and Chai) recovers the direction from the runner's own text and hands it to the model as a labelled fact rather than leaving it to re-derive from the raw message; the parser returns `null` rather than guess for any format it does not recognise unambiguously.

"Create bug" carried this same inversion further: it repeated the backwards reading and stated it as a firm cause even when the underlying analysis was Inconclusive. Both places a bug body is drafted now carry the parsed `Expected:`/`Actual:` lines and a cause line that matches the analysis's own confidence — "not established" when there is no analysis or the analysis was Inconclusive, and explicitly labelled "AI hypothesis — not a verified diagnosis" otherwise — sharing one helper so the two builders cannot drift apart.

Fizzy #2225.
