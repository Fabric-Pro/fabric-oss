# Step 1: Get Spec Requirements

> **Usage**: Reference with `@.cursor/commands/1-get-spec-requirements.md` or copy into chat

---

## Workflow Instructions

The FIRST STEP is to make sure you have ONE OR BOTH of these files to inform your tasks breakdown:
- `fabric/specs/[this-spec]/spec.md`
- `fabric/specs/[this-spec]/planning/requirements.md`

IF you don't have ONE OR BOTH of those files in your current conversation context, ask the user to provide direction by outputting:

```
📝 I'll need a spec.md or requirements.md (or both) to build a tasks list.

Please direct me to where I can find those. If you haven't created them yet, you can run:
- @.cursor/prompts/shape-spec.md
- @.cursor/prompts/write-spec.md
```

---

## Display Confirmation and Next Step

Once you've confirmed you have the spec and/or requirements, output the following message (replace `[this-spec]` with the folder name for this spec):

```
✅ I have the spec and requirements at `fabric/specs/[this-spec]/`.

NEXT STEP 👉 Run @.cursor/commands/2-create-tasks-list.md
```

