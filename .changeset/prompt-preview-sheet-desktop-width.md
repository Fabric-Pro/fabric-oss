---
"fabric-app": patch
---

The prompt preview panel now opens at its intended 600px width on desktop instead of a cramped 384px.

Found while verifying Fizzy #2250. `PromptPreviewSheet` asks for `sm:w-[600px]`, but the Sheet primitive's right side carries `sm:max-w-sm` (24rem) and tailwind-merge keeps width and max-width in separate groups, so the width was silently clamped: measured on staging at 384px wide at both 1440px and 1024px viewports. The panel now also passes `sm:max-w-[600px]`, the same per-panel override the version-history sheets use, with no change to the shared primitive. Phone width is unchanged (full width below `sm`).
