---
"fabric-app": patch
---

Log an error when a publishing prompt's built-in default body also fails to render, instead of reporting only a clean recovery.

The nine publishing prompt composers now share one recovery path for an organization prompt body that does not render. Behaviour is otherwise unchanged: the same three checks decide when the default body is used, the existing log line is emitted with the same text, and the draft is still marked as generated from the default prompt.
