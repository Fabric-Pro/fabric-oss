---
"fabric-app": patch
---

Pin the Daily Brief collector caps with a test that measures what they prevent

Fizzy #1997. The existing tests assert the caps exist; this one asserts they matter — an uncapped busy project (50 connected repos at the per-repo ceiling plus a large story backlog) serializes to 4,579,479 bytes, past the 4,128,768-byte budget, while the capped shape lands at 255,879. If a future change weakens a cap, this fails with the numbers rather than a missing-symbol assertion.
