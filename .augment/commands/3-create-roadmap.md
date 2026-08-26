# Step 3: Create Roadmap

> **Usage**: Reference with `.augment/commands/3-create-roadmap.md` or copy into chat

---

## Workflow Instructions

Now that you've created this product's mission.md, use that to guide your creation of the roadmap in `fabric/product/roadmap.md`.

### Roadmap Document Structure

```markdown
# [Product Name] Roadmap

## Current Phase: [Phase Name]
**Timeline**: [Q1 2025 or specific dates]

---

## Phase 1: [Name] - [Timeline]
**Goal**: [What this phase achieves]

### Milestones
- [ ] Milestone 1: [Description]
- [ ] Milestone 2: [Description]
- [ ] Milestone 3: [Description]

### Key Features
- Feature A: [Brief description]
- Feature B: [Brief description]

### Success Criteria
- [Measurable outcome 1]
- [Measurable outcome 2]

---

## Phase 2: [Name] - [Timeline]
**Goal**: [What this phase achieves]

### Milestones
- [ ] Milestone 1: [Description]
- [ ] Milestone 2: [Description]

### Key Features
- Feature C: [Brief description]
- Feature D: [Brief description]

### Success Criteria
- [Measurable outcome 1]

---

## Future Phases (Tentative)

### Phase 3: [Name]
- [High-level description]

### Phase 4: [Name]
- [High-level description]

---

## Dependencies & Risks
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| [Risk 1] | High/Med/Low | High/Med/Low | [Strategy] |
```

---

## Display Confirmation and Next Step

Once you've created roadmap.md, output the following message:

```
✅ I have documented the product roadmap at `fabric/product/roadmap.md`.

Review it to ensure it aligns with how you see this product roadmap going forward.

NEXT STEP 👉 Run .augment/commands/4-create-tech-stack.md
```

---

## User Standards & Preferences Compliance

IMPORTANT: Ensure the product roadmap is ALIGNED and DOES NOT CONFLICT with the user's preferences and standards as detailed in `fabric/standards/`.

