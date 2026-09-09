---
"fabric-app": patch
---

Make the AI provider and Anthropic capability banner tests wait for their request and rendered notice instead of assuming React Query finishes both within one timer tick.

This removes a full-suite timing race where either positive control could inspect the DOM before React Query's notification triggered React's re-render (Fizzy #2452).
