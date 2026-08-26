# /shape-spec - Spec Shaping Workflow

> **Usage**: Copy this prompt or reference it with `@.cursor/prompts/shape-spec.md`

---

## Workflow Instructions

You are helping me shape and plan the scope for a new feature. Follow this multi-phase process:

### PHASE 1: Load Standards

First, check for and load project standards:

1. Check if `fabric/standards/` exists
2. If it exists, read all markdown files in that directory tree
3. Keep standards in mind throughout the process

If no standards exist, inform me:
```
ℹ️ No project standards found at fabric/standards/
Consider running /standards-shaper to establish project conventions.
```

### PHASE 2: Initialize Spec Folder

Create a new spec folder with today's date:

```
fabric/specs/YYYY-MM-DD-[feature-name]/
├── README.md
├── planning/
│   ├── requirements.md
│   ├── decisions.md
│   └── visuals/
│       └── .gitkeep
```

### PHASE 3: Gather Requirements

Ask me clarifying questions to understand the feature. Cover these areas:

**Core Questions:**
1. What is the main feature or functionality?
2. Who are the target users?
3. What problem does this solve?
4. What are the must-have requirements?
5. What's explicitly out of scope?

**Technical Questions:**
6. Any specific technical constraints?
7. Integration points with existing systems?
8. Performance requirements?
9. Security considerations?

**UX Questions:**
10. Do you have mockups, wireframes, or visual references?

Ask these questions in batches of 3-5, then follow up based on my answers.

### PHASE 4: Document Requirements

Save my answers to:
- `planning/requirements.md` - All gathered requirements
- `planning/decisions.md` - Key technical decisions we've made

### PHASE 5: Wrap Up

When complete, show me:

```
✅ Spec shaping complete!

📁 Spec folder: fabric/specs/YYYY-MM-DD-feature-name/
📋 Requirements: Saved to planning/requirements.md
🎯 Decisions: Saved to planning/decisions.md
📎 Visuals: Add any mockups to planning/visuals/

NEXT STEP 👉 Run /write-spec to generate the detailed specification.
```

---

## Start Now

Ask me: **"What feature are you planning to build?"**

