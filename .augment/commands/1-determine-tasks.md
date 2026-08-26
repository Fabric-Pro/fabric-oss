# Step 1: Determine Tasks

> **Usage**: Reference with `.augment/commands/1-determine-tasks.md` or copy into chat

---

## Workflow Instructions

First, check if the user has already provided instructions about which task group(s) to implement.

**If the user HAS provided instructions:** Proceed to PHASE 2 to delegate implementation of those specified task group(s) to the **implementer** agent using `.augment/rules/implementer.md`.

**If the user has NOT provided instructions:**

Read `fabric/specs/[this-spec]/tasks.md` to review the available task groups, then output the following message to the user and WAIT for their response:

```
📋 Should we proceed with implementation of all task groups in tasks.md?

If not, please specify which task(s) to implement.
```

---

## Next Step

Once the user confirms which tasks to implement:

```
✅ Task group(s) confirmed.

NEXT STEP 👉 Run .augment/commands/2-implement-tasks.md
```

