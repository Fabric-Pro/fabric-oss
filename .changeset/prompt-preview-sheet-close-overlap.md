---
"fabric-app": patch
---

The prompt preview panel's close button no longer sits on top of the prompt's scope badge.

Found while verifying Fizzy #2250. The Sheet primitive positions its close button absolutely at `top-4 right-4`, and `PromptPreviewSheet`'s header row ran underneath it: measured on staging, the button's left edge sat 8px inside the scope badge ("Personal") at 1440, 1024 and 390px viewports. The header now reserves the corner with `pr-8`, the same clearance `IntegrationIncidentDrawer` uses.
