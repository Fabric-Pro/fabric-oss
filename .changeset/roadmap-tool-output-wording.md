---
"fabric-app": patch
---

The AI assistant now reports roadmap totals as shown on the page and recognizes declined or closed work items as existing rather than missing.

Fizzy #2040 follow-up. A staging retest of the live roadmap reads showed the model misreading correct tool output in two ways. It subtracted `hiddenCount` from `total` ("191 visible (199 total, 8 hidden)") even though `total` already excludes hidden items. It also concluded a declined bug did not exist because the list tool never shows declined items, even though `fabric_get_project_feature` had just returned it.

`fabric_list_project_features` now returns a one-sentence `summary` ("199 items on the roadmap; 8 items closed and hidden, already excluded from total — report 199, never subtract the hidden count.") alongside the unchanged `total`/`hiddenCount`/`hasMore`. `fabric_get_project_feature` now returns `onRoadmap`, plus `hiddenReason` ("declined" | "closed") and a `note` when the roadmap hides the item. The tool descriptions (activity catalog and the workflow-side pre-registered copies) say the same. No change to which rows either tool returns; the MCP gateway's `listStorySummaries` defaults are untouched.

The orchestrator's pre-planning intake check (`INTENT_CLARITY_PROMPT` in `analyzeIntentClarityActivity`) now treats prefix-plus-number identifiers (F-, US-, B-) as the attached project's roadmap items, so "compare F-003 and F-005" no longer stops at "What are F-003 and F-005?" before the get tool is called.
