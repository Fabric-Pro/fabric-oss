---
"fabric-app": patch
---

A coding-instructions file whose frontmatter double-quotes a value containing a `"` or `\` now reads back with those characters decoded, so a lesson or skill title written with correct YAML escaping shows the title itself rather than the escape sequences.

Only the two escapes a double-quoted YAML scalar requires, `\"` and `\\`, are decoded; every other backslash sequence, plain values and single-quoted values read exactly as before.
