# /write-spec - Specification Writing Workflow

> **Usage**: Copy this prompt or reference it with `@.cursor/prompts/write-spec.md`

---

## Workflow Instructions

You are writing a detailed technical specification based on shaped requirements.

### PHASE 1: Gather Context

1. **Find the spec folder**: Look for the most recent folder in `fabric/specs/` or ask me which spec to write
2. **Read requirements**: Load `planning/requirements.md`
3. **Read decisions**: Load `planning/decisions.md`
4. **Check visuals**: Note any files in `planning/visuals/`
5. **Load standards**: Read all files in `fabric/standards/`

### PHASE 2: Write the Specification

Create `spec.md` in the spec folder with these sections:

```markdown
# [Feature Name] Specification

## 1. Overview
- Feature description
- Goals and objectives
- Success metrics

## 2. User Stories
For each user story:
- As a [role], I want [feature], so that [benefit]
- Acceptance criteria (specific, measurable)

## 3. Technical Architecture
- System components involved
- Data flow diagrams (describe in text or ASCII)
- Integration points

## 4. Data Models
- Database schema changes
- Entity relationships
- Data validation rules

## 5. API Specifications
For each endpoint:
- Method and path
- Request format
- Response format
- Error responses
- Authentication requirements

## 6. UI/UX Specifications
- Component hierarchy
- User flows
- Accessibility requirements
- Responsive behavior

## 7. Security Considerations
- Authentication requirements
- Authorization rules
- Data protection
- Input validation

## 8. Error Handling
- Error scenarios
- User-facing messages
- Logging requirements

## 9. Testing Strategy
- Unit test scenarios
- Integration test scenarios
- E2E test scenarios
- Edge cases

## 10. Performance Requirements
- Expected load
- Response time targets
- Caching strategy

## 11. Deployment Considerations
- Feature flags
- Migration strategy
- Rollback plan

## 12. Open Questions
- Any unresolved decisions
- Items needing clarification
```

### PHASE 3: Validate Completeness

Before saving, ensure:
- [ ] All user stories have acceptance criteria
- [ ] API specs are complete (request/response/errors)
- [ ] Security considerations addressed
- [ ] Testing strategy defined
- [ ] Aligns with project standards

### PHASE 4: Save and Report

Save the specification to `fabric/specs/[spec-folder]/spec.md`

Then show:

```
✅ Specification written!

📄 Spec: fabric/specs/YYYY-MM-DD-feature/spec.md

SUMMARY:
- [X] user stories with acceptance criteria
- [X] API endpoints defined
- [X] Data models specified
- [X] Security considerations documented
- [X] Testing strategy outlined

NEXT STEP 👉 Run /create-tasks to break this into implementation tasks.
```

---

## Start Now

Ask me: **"Which spec folder should I write the specification for?"** and list available folders in `fabric/specs/`

