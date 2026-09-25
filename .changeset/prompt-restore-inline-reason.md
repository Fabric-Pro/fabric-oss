---
"fabric-app": patch
---

Restoring a prompt version that is blank or over 50,000 characters is now disabled in the version comparison, with the reason shown beside the button.

Fizzy #2250 follow-up (the last item from its post-ship review). An old version can predate the save rules a restore now runs through — saved blank before the blank-body check, or longer than the new length limit. Restoring it is a `prompts.version.create` call, which refuses such a body, so the user previously clicked Restore and got a "Failed to restore version" toast after the request. `PromptVersionCompareDialog` now applies the shared `promptContentProblem` check to the selected version: Restore is disabled, and an inline message ("This version can't be restored. …", the server's own wording) sits above the footer as a `role="alert"`, linked to the button with `aria-describedby` (a disabled button is not focusable, so the description alone may never be announced). A version that fails only the template parser under the prompt's current format is still caught by the server, as before.
