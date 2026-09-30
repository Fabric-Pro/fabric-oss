---
"fabric-app": patch
---

Parlume now waits for the requester to finish speaking before answering, so a request split across transcript segments is no longer cut off by its own continuation. Only speech while Parlume is audible interrupts it, and live transcription recognizes the Parlume name.
