---
"fabric-app": patch
---

Long feature titles no longer push the Remove AI Recommended Items dialog wider than the screen and hide its confirm button.

Found in staging QA of Fizzy #2211. DialogContent is a CSS grid, and its children defaulted to min-width: auto, so the per-row truncate never applied. The dialog's direct children now get min-w-0.
