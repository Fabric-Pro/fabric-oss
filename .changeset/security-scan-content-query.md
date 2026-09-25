---
"fabric-app": patch
---

Security & Accessibility scans of large projects cover up to 200 items again: the AI scanners now read the project content themselves instead of receiving it through the workflow.

Fizzy #2502, follow-up to the payload budget. The 1.2 MB budget kept large projects within Temporal's 2 MB payload limit, but it also cut coverage for projects whose recent items came to between about 1.2 and 2 MB, which used to scan all 200 items; in FULL mode the dropped items' findings were not carried forward either. The gather activity now returns a content query (project, story, target, mode and the incremental window start) instead of the item text, and each scanner activity re-runs `getProjectScanContent` with it, so no item text crosses Temporal and the byte budget is removed. A gather result recorded before this change still carries its items, and the workflow passes them through as before. A new test replays a recorded failing scan whose `failScanActivity` message and scanner input were rewritten to the pre-change shapes, confirming the SDK does not compare recorded activity inputs, so neither this change nor the earlier failure-message change needs a patch marker.
