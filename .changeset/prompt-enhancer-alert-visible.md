---
"fabric-app": patch
---

The reason a prompt body cannot be saved is now always visible in the prompt enhancer, and the prompt preview panel fits on phone screens.

Fizzy #2250, both found by a staging UI sweep across desktop (1440×1000) and mobile (390×844), light and dark. First, the enhancer's editor area does not scroll, and the message explaining why Save is disabled (empty, blank or over-50,000-character body) was rendered below the textarea — correctly wired (`role="alert"`, `aria-describedby`) but below the fold at every viewport, so a sighted user saw only a disabled Save button; it now renders directly above the textarea. Second, `PromptPreviewSheet` had a fixed `w-[500px]` below the `sm` breakpoint, so on a 390px phone the right-anchored sheet pushed its left edge — including the Edit button, and with it the inline validation — off screen; it is now full width below `sm` (unchanged at `sm` and up). The format help that follows the enhancer's textarea is clipped the same way as the old message; that pre-existing layout issue is left for its own change.
