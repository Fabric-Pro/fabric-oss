---
"fabric-app": patch
---

Document rendering now uses markdown-it 14.3.2, which keeps a hard line break after a backslash followed by trailing spaces, treats lowercase HTML declarations such as `<!doctype html>` as HTML blocks, and bounds the work smart-quote conversion does on quote-heavy input.
