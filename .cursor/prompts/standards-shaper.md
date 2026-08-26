# /standards-shaper - Project Standards Workflow

> **Usage**: Copy this prompt or reference it with `@.cursor/prompts/standards-shaper.md`

---

## Workflow Instructions

You are creating comprehensive coding standards for this project.

### PHASE 1: Analyze the Project

1. **Detect Tech Stack**: Analyze `package.json`, config files, and existing code
2. **Identify Patterns**: Look at existing code for established patterns
3. **Note Conventions**: Find naming conventions, file structure patterns

### PHASE 2: Create Standards Structure

Create `fabric/standards/` with this structure:

```
fabric/standards/
├── README.md
├── global/
│   ├── coding-style.md
│   ├── error-handling.md
│   ├── conventions.md
│   └── validation.md
├── frontend/
│   ├── components.md
│   ├── css.md
│   ├── accessibility.md
│   └── responsive.md
├── backend/
│   ├── api.md
│   ├── models.md
│   ├── queries.md
│   └── migrations.md
└── testing/
    └── test-writing.md
```

### PHASE 3: Write Standards

For each standards file, include:

1. **DO** - Preferred patterns with examples
2. **DON'T** - Anti-patterns to avoid with examples
3. **Examples** - Code snippets using the project's actual tech stack

#### Template for Each Standard:

```markdown
# [Standard Name]

## Overview
[Brief description of what this standard covers]

## ✅ DO

### [Pattern Name]
[Description of why this is preferred]

\`\`\`typescript
// Good example using project's tech stack
\`\`\`

### [Another Pattern]
...

## ❌ DON'T

### [Anti-Pattern Name]
[Why this should be avoided]

\`\`\`typescript
// Bad example
\`\`\`

## Examples

### [Use Case]
\`\`\`typescript
// Complete example showing the pattern in context
\`\`\`
```

### Standards Content Guide

#### global/coding-style.md
- Naming conventions (files, functions, variables)
- Code organization
- Import ordering
- Comment guidelines

#### global/error-handling.md
- Error types and hierarchy
- Try-catch patterns
- User-facing error messages
- Logging patterns

#### global/conventions.md
- File naming
- Folder structure
- Export patterns
- Type definitions

#### global/validation.md
- Input validation patterns
- Schema definitions
- Sanitization rules

#### frontend/components.md
- Component structure
- Props patterns
- State management
- Composition patterns

#### frontend/css.md
- Tailwind/CSS conventions
- Responsive patterns
- Theme usage
- Animation guidelines

#### backend/api.md
- Endpoint naming
- Request/response formats
- Authentication patterns
- Rate limiting

#### backend/models.md
- Schema conventions
- Relationship patterns
- Validation rules

#### testing/test-writing.md
- Test structure (Arrange-Act-Assert)
- Naming conventions
- Mock patterns
- Coverage expectations

### PHASE 4: Summary

```
✅ Standards created!

📁 Created: fabric/standards/
├── README.md
├── global/
│   ├── coding-style.md
│   ├── error-handling.md
│   ├── conventions.md
│   └── validation.md
├── frontend/
│   ├── components.md
│   ├── css.md
│   ├── accessibility.md
│   └── responsive.md
├── backend/
│   ├── api.md
│   ├── models.md
│   ├── queries.md
│   └── migrations.md
└── testing/
    └── test-writing.md

DETECTED TECH STACK:
- [Framework]: [Version]
- [Database]: [Type]
- [Styling]: [Approach]
- [Testing]: [Framework]

All standards include examples using YOUR tech stack.

NEXT STEPS:
1. Review and customize the generated standards
2. Run /plan-product to define product vision
3. Run /shape-spec for your first feature
```

---

## Start Now

Say: **"I'll analyze your project to create tailored coding standards."** Then examine package.json and existing code.

