# /standards-shaper

Create project-wide coding standards and conventions.

## Purpose

Establish consistent coding standards for your project before development begins. This ensures all team members and AI assistants follow the same patterns.

## When to Use

- Once per project, before any development
- When onboarding a new codebase
- When updating team conventions

## Process

### Step 1: Detect Tech Stack

Analyze the project to identify:
- Programming languages
- Frameworks (React, Next.js, Vue, etc.)
- Package managers (npm, pnpm, yarn, bun)
- Testing frameworks
- Database technologies

### Step 2: Create Standards Structure

Create `fabric/standards/` with:

```
fabric/standards/
├── global/
│   ├── coding-style.md      # Naming, formatting, structure
│   ├── error-handling.md    # Error patterns
│   └── conventions.md       # Project-specific conventions
├── frontend/
│   ├── components.md        # Component patterns
│   └── css.md               # Styling conventions
├── backend/
│   ├── api.md               # API design patterns
│   └── models.md            # Data model patterns
└── testing/
    └── test-writing.md      # Testing conventions
```

### Step 3: Generate Standards Content

For each category, document:

1. **DO** - Best practices to follow
2. **DON'T** - Anti-patterns to avoid
3. **Examples** - Code samples showing correct usage

### Step 4: Ask for Customization

Ask the user:
- Any specific naming conventions?
- Preferred error handling patterns?
- Testing requirements?
- Any existing patterns to document?

## Output Example

```markdown
# Coding Style Standards

## Naming Conventions

### DO
- Use `camelCase` for variables and functions
- Use `PascalCase` for components and classes
- Use `SCREAMING_SNAKE_CASE` for constants

### DON'T
- Don't use abbreviations (use `user` not `usr`)
- Don't use single-letter names except in loops

### Examples
```javascript
// Good
const userProfile = await getUserById(userId);

// Bad
const up = await getUser(uid);
```
```

## Completion

After creating standards, inform the user:

```
✅ Standards created!

📁 Created: fabric/standards/
├── global/ (3 files)
├── frontend/ (2 files)
├── backend/ (2 files)
└── testing/ (1 file)

💡 Tip: All Fabric agents will now follow these standards.

NEXT STEP 👉 Run `/plan-product` to define your product vision.
```

