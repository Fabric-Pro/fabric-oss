# Cursor Native Features Guide

This guide helps you leverage Cursor's native features for maximum productivity with the Fabric framework.

## Cursor's Unique Capabilities

### 1. .mdc Rules (Auto-Activating Context)

Cursor's `.mdc` files in `.cursor/rules/` automatically activate based on file patterns.

**How It Works:**
- Rules are markdown files with `.mdc` extension
- Glob patterns determine when rules activate
- Multiple rules can activate simultaneously

**Example Rule:**

```markdown
---
patterns:
  - "**/*.ts"
  - "**/*.tsx"
---

# TypeScript Development Rules

When writing TypeScript:
- Use strict type checking
- Prefer interfaces over types for objects
- Use const assertions for literal types
- Avoid `any` - use `unknown` instead

Reference: @.cursor/skills/typescript/SKILL.md
```

**When you open a `.ts` file, this rule automatically activates!**

### 2. Global .cursorrules File

Create `.cursorrules` in project root for global context:

```markdown
# Project: [Your Project Name]

## Tech Stack
- Next.js 14 (App Router)
- TypeScript
- Tailwind CSS
- PostgreSQL

## Coding Standards
Reference: @fabric/standards/coding-standards.md

## Workflow
Follow Fabric framework:
1. Shape spec: @.cursor/prompts/shape-spec.md
2. Write spec: @.cursor/prompts/write-spec.md
3. Create tasks: @.cursor/prompts/create-tasks.md
4. Implement: @.cursor/prompts/implement-tasks.md

## File Structure
- Specs: fabric/specs/YYYY-MM-DD-name/
- Standards: fabric/standards/
- Tests: __tests__/ or *.test.ts

## Testing
- Use Vitest for unit tests
- Use Playwright for E2E tests
- Follow TDD approach
```

This context applies to ALL Cursor interactions in your project.

### 3. @ Reference System

Cursor's `@` system for referencing context:

**@Files** - Reference specific files:
```
@fabric/specs/2024-01-15-auth/spec.md
@fabric/standards/coding-standards.md
Implement authentication following the spec and standards
```

**@Folders** - Reference entire directories:
```
@src/components/
Create a new Button component following existing patterns
```

**@Agents** - Reference agent files:
```
@.cursor/agents/implementer.md
Implement the next task
```

**@Prompts** - Reference workflow prompts:
```
@.cursor/prompts/implement-tasks.md
```

**@Skills** - Reference skills:
```
@.cursor/skills/nextjs/SKILL.md
Show me Next.js App Router patterns
```

### 4. Composer Mode

Cursor Composer allows multi-file editing:

**Activate:** `Cmd+Shift+I` / `Ctrl+Shift+I`

**Use Cases:**
- Refactoring across multiple files
- Creating related components
- Updating tests with implementation
- Migrating patterns

**Example:**
```
@fabric/standards/coding-standards.md

Refactor all API routes to use the new error handling pattern
```

Composer will suggest changes across all affected files.

### 5. Cmd+K (Inline Edit)

Quick inline edits with `Cmd+K` / `Ctrl+K`:

**Use Cases:**
- Quick fixes
- Refactoring single functions
- Adding comments
- Generating tests

**Example:**
```
[Select function]
Cmd+K: Add JSDoc comments and error handling
```

### 6. Tab (Autocomplete)

Cursor's autocomplete is context-aware:

**Triggers:**
- Typing function names
- Writing comments
- Creating new files
- Following patterns

**Best Practices:**
- Write descriptive comments before code
- Use consistent naming
- Follow existing patterns
- Let Cursor suggest implementations

### 7. Chat Modes

**Normal Chat** - `Cmd+L` / `Ctrl+L`
- General questions
- Code explanations
- Debugging help

**Composer** - `Cmd+Shift+I` / `Ctrl+Shift+I`
- Multi-file edits
- Large refactorings
- Feature implementation

**Inline** - `Cmd+K` / `Ctrl+K`
- Quick edits
- Single function changes
- Inline fixes

## Fabric Workflow with Cursor Native Features

### Setup: Create .cursorrules

```markdown
# [Project Name] - Fabric Framework

Follow the Fabric spec-driven development workflow.

## Agents
- @.cursor/agents/implementer.md - Full-stack implementation
- @.cursor/agents/backend-specialist.md - API development
- @.cursor/agents/frontend-specialist.md - UI development

## Workflow Prompts
- @.cursor/prompts/shape-spec.md - Requirements gathering
- @.cursor/prompts/write-spec.md - Specification writing
- @.cursor/prompts/create-tasks.md - Task breakdown
- @.cursor/prompts/implement-tasks.md - Implementation

## Standards
All code must follow: @fabric/standards/coding-standards.md

## Testing
- TDD approach required
- Tests in __tests__/ or *.test.ts
- Use Vitest for unit tests
```

### Phase 1: Spec Shaping

```
Cmd+L (Chat)
@.cursor/prompts/shape-spec.md
I want to build user authentication
```

### Phase 2: Spec Writing

```
Cmd+L
@.cursor/prompts/write-spec.md
@fabric/specs/2024-01-15-auth/spec.md
Write the detailed specification
```

### Phase 3: Task Creation

```
Cmd+L
@.cursor/prompts/create-tasks.md
@fabric/specs/2024-01-15-auth/spec.md
Break into tasks
```

### Phase 4: Implementation

**Option A: Composer (Multi-file)**
```
Cmd+Shift+I (Composer)
@.cursor/prompts/implement-tasks.md
@.cursor/agents/implementer.md
@fabric/specs/2024-01-15-auth/tasks.md
@fabric/standards/coding-standards.md

Implement all authentication tasks
```

**Option B: Inline (Single file)**
```
[Open file]
Cmd+K
@.cursor/agents/backend-specialist.md
Implement the login endpoint
```

### Phase 5: Testing

```
Cmd+Shift+I (Composer)
@.cursor/agents/test-specialist.md
@src/auth/

Generate comprehensive tests for all auth functions
```

### Phase 6: Verification

```
Cmd+L
@.cursor/prompts/3-verify-implementation.md
@fabric/specs/2024-01-15-auth/spec.md
Verify implementation
```

## Auto-Activating Rules

Create rules that activate automatically:

### TypeScript Rule

**File:** `.cursor/rules/typescript.mdc`
```markdown
---
patterns:
  - "**/*.ts"
  - "**/*.tsx"
---

# TypeScript Standards

- Use strict mode
- Prefer interfaces for objects
- Use const assertions
- Avoid `any`

Reference: @.cursor/skills/typescript/SKILL.md
```

### React Component Rule

**File:** `.cursor/rules/react-components.mdc`
```markdown
---
patterns:
  - "**/components/**/*.tsx"
  - "**/app/**/*.tsx"
---

# React Component Standards

- Use functional components
- TypeScript for props
- Tailwind for styling
- Accessibility required

Reference: @.cursor/skills/react/SKILL.md
```

### API Route Rule

**File:** `.cursor/rules/api-routes.mdc`
```markdown
---
patterns:
  - "**/app/api/**/*.ts"
  - "**/pages/api/**/*.ts"
---

# API Route Standards

- Validate all inputs
- Use standard response format
- Handle errors properly
- Add rate limiting

Reference: @.cursor/skills/api-design/SKILL.md
```

### Test File Rule

**File:** `.cursor/rules/tests.mdc`
```markdown
---
patterns:
  - "**/*.test.ts"
  - "**/*.test.tsx"
  - "**/__tests__/**"
---

# Testing Standards

- Follow AAA pattern (Arrange, Act, Assert)
- Test happy path and edge cases
- Mock external dependencies
- Use descriptive test names

Reference: @.cursor/skills/testing/SKILL.md
```

## Best Practices

### 1. Use .cursorrules for Project Context

Create a comprehensive `.cursorrules` file with:
- Tech stack
- Coding standards
- Workflow guidance
- File structure
- Testing approach

### 2. Create Specific .mdc Rules

Make rules for:
- File types (TypeScript, React, etc.)
- Directories (components, API routes, etc.)
- Patterns (tests, configs, etc.)

### 3. Leverage @ References

```
✅ @fabric/standards/coding-standards.md
   @.cursor/agents/implementer.md
   @fabric/specs/2024-01-15-auth/tasks.md
   Implement next task

❌ Implement next task
```

### 4. Choose Right Mode

- **Cmd+K** - Single function/small edit
- **Cmd+L** - Questions, explanations, planning
- **Cmd+Shift+I** - Multi-file edits, features

### 5. Write Descriptive Comments

```typescript
// Create a user authentication service that:
// - Validates email and password
// - Hashes password with bcrypt
// - Returns JWT token on success
// - Throws AuthError on failure
```

Cursor will suggest implementation based on comment.

## Advanced Patterns

### Multi-File Refactoring

```
Cmd+Shift+I (Composer)
@fabric/standards/coding-standards.md
@src/

Refactor all files to use the new error handling pattern
```

### Pattern Replication

```
@src/components/Button.tsx
@src/components/

Create Input, Select, and Checkbox components
following the same pattern as Button
```

### Test Generation

```
@src/auth/service.ts
@.cursor/agents/test-specialist.md

Generate comprehensive tests covering all edge cases
```

## Keyboard Shortcuts

- `Cmd+L` / `Ctrl+L` - Open Chat
- `Cmd+K` / `Ctrl+K` - Inline Edit
- `Cmd+Shift+I` / `Ctrl+Shift+I` - Composer
- `Tab` - Accept autocomplete
- `Esc` - Dismiss suggestion

## Tips for Maximum Productivity

### 1. Set Up .cursorrules First

Before starting development, create a comprehensive `.cursorrules` file.

### 2. Create Domain-Specific Rules

Make `.mdc` rules for your specific domains (auth, payments, etc.).

### 3. Use Composer for Features

Use Composer mode for implementing complete features across multiple files.

### 4. Reference Standards Always

Always include `@fabric/standards/coding-standards.md` in requests.

### 5. Let Autocomplete Work

Write comments describing what you want, then let Tab autocomplete suggest implementation.

## Troubleshooting

### Rules Not Activating

**Issue:** .mdc rules not applying
**Solution:** Check glob patterns match your files, reload Cursor window

### Autocomplete Not Working

**Issue:** Tab not suggesting code
**Solution:** Write more descriptive comments, ensure file has proper extension

### Composer Changes Too Broad

**Issue:** Composer suggesting changes to too many files
**Solution:** Be more specific, reference exact files with @

## Next Steps

1. **Create .cursorrules** in project root
2. **Add .mdc rules** for common file types
3. **Try Composer mode** for multi-file edits
4. **Use @ references** liberally
5. **Leverage autocomplete** with descriptive comments

## Resources

- [Cursor Documentation](https://docs.cursor.com/)
- [Fabric Framework README](../../../README.md)
- [Workflow Guide](../../shared/default/RECOMMENDED_WORKFLOW.md)

