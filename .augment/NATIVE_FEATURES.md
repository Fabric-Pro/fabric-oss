# Augment (Auggie CLI) Native Features Guide

This guide helps you leverage Augment's native features for maximum productivity with the Fabric framework.

## Augment's Unique Capabilities

### 1. Rules System

Augment uses a **rules-based system** where agents are defined as rules in `~/.augment/rules/`.

**How It Works:**
- Each rule is a markdown file
- Rules provide context and guidance
- Augment automatically applies relevant rules

**Example Rule Structure:**

```markdown
# Implementer Rule

You are a full-stack developer implementing features following specifications.

## When to Apply
- Implementing tasks from fabric/specs/*/tasks.md
- Following TDD approach
- Full-stack development work

## Guidelines
- Write tests first
- Follow coding standards in fabric/standards/
- Keep functions small and focused
- Update tasks.md as you complete work

## Skills
Reference skills from ~/.augment/skills/ for deep expertise.
```

### 2. @ Reference System

Augment's `@` system allows referencing files and context:

**Reference Rules (Agents):**
```
@~/.augment/rules/implementer.md
Implement the authentication feature
```

**Reference Standards:**
```
@fabric/standards/global/coding-style.md
Refactor this code to follow our standards
```

**Reference Specs:**
```
@fabric/specs/2024-01-15-auth/spec.md
@fabric/specs/2024-01-15-auth/tasks.md
Implement the next task
```

**Reference Multiple Files:**
```
@fabric/standards/global/coding-style.md
@fabric/specs/2024-01-15-auth/spec.md
@~/.augment/rules/backend-specialist.md
Design the authentication API
```

### 3. Codebase Retrieval

Augment has powerful codebase search and retrieval:

**Search for Code:**
```
Find all authentication-related code in the codebase
```

**Find Patterns:**
```
Show me how we handle API errors in existing code
```

**Locate Implementations:**
```
Where is the user model defined?
```

**Best Practices:**
- Use natural language queries
- Be specific about what you're looking for
- Augment will find relevant code across the entire codebase

### 4. Task Management

Augment has built-in task management features:

**Create Tasks:**
```
Create a task list for implementing user authentication
```

**Track Progress:**
```
Show me the status of tasks in fabric/specs/2024-01-15-auth/tasks.md
```

**Update Tasks:**
```
Mark the "Create user model" task as complete
```

### 5. Memory and Context

Augment maintains context across conversations:

**Remember Decisions:**
```
Remember: We're using bcrypt for password hashing with cost factor 12
```

**Recall Context:**
```
What did we decide about password hashing?
```

**Project Context:**
Augment automatically understands your project structure and conventions.

### 6. Commands

Augment commands in `~/.augment/commands/` provide workflow guidance:

```bash
# Reference commands for workflows
@~/.augment/commands/shape-spec.md
@~/.augment/commands/implement-tasks.md
@~/.augment/commands/create-tasks.md
```

## Fabric Workflow with Augment Native Features

### Phase 1: Spec Shaping

```
@~/.augment/commands/shape-spec.md
@~/.augment/rules/spec-shaper.md

I want to build a user authentication system
```

Augment will:
- Ask strategic questions
- Use codebase retrieval to find similar features
- Create spec outline in fabric/specs/

### Phase 2: Spec Writing

```
@~/.augment/commands/write-spec.md
@~/.augment/rules/spec-writer.md
@fabric/specs/2024-01-15-auth/spec.md

Write the detailed specification
```

Augment will:
- Reference existing patterns in codebase
- Follow standards from fabric/standards/
- Create comprehensive spec

### Phase 3: Task Creation

```
@~/.augment/commands/create-tasks.md
@~/.augment/rules/tasks-list-creator.md
@fabric/specs/2024-01-15-auth/spec.md

Break this spec into tasks
```

Augment will:
- Analyze spec complexity
- Create logical task groups
- Identify dependencies
- Save to fabric/specs/*/tasks.md

### Phase 4: Implementation

```
@~/.augment/commands/implement-tasks.md
@~/.augment/rules/implementer.md
@fabric/specs/2024-01-15-auth/tasks.md
@fabric/standards/global/coding-style.md

Implement the next task
```

Augment will:
- Use codebase retrieval to find similar implementations
- Follow coding standards
- Write tests first (TDD)
- Update tasks.md with progress

### Phase 5: Verification

```
@~/.augment/rules/implementation-verifier.md
@fabric/specs/2024-01-15-auth/spec.md
@fabric/specs/2024-01-15-auth/tasks.md

Verify the implementation
```

Augment will:
- Check all acceptance criteria
- Run tests
- Verify standards compliance
- Generate verification report

## Advanced Patterns

### Codebase-Aware Implementation

Leverage Augment's codebase retrieval:

```
@~/.augment/rules/backend-specialist.md

Find how we implement authentication in existing code,
then implement JWT authentication for the new API
following the same patterns
```

Augment will:
1. Search codebase for auth patterns
2. Analyze existing implementations
3. Apply same patterns to new code
4. Ensure consistency

### Context-Rich Refactoring

```
@fabric/standards/global/coding-style.md

Find all files that don't follow our error handling pattern
and refactor them to be consistent
```

Augment will:
1. Search for error handling code
2. Identify inconsistencies
3. Suggest refactoring
4. Apply changes consistently

### Intelligent Task Breakdown

```
@~/.augment/rules/tasks-list-creator.md

Analyze the codebase structure and create tasks that align
with our existing architecture
```

Augment will:
1. Understand current architecture
2. Create tasks that fit naturally
3. Avoid architectural conflicts
4. Suggest improvements

## Best Practices

### 1. Use @ References Liberally

```
✅ @fabric/standards/global/coding-style.md
   @~/.augment/rules/implementer.md
   @fabric/specs/2024-01-15-auth/tasks.md
   Implement the next task

❌ Implement the next task
```

More context = better results.

### 2. Leverage Codebase Retrieval

Before implementing, ask:
```
Show me similar implementations in the codebase
How do we handle this pattern elsewhere?
What's our convention for this?
```

### 3. Use Rules for Consistency

Create custom rules for project-specific patterns:

```markdown
# ~/.augment/rules/our-api-pattern.md

## API Response Format

Always use this format:
{
  "success": boolean,
  "data": any,
  "error": { code, message } | null
}

## Error Handling

Use AppError class for all errors.
```

Then reference it:
```
@~/.augment/rules/our-api-pattern.md
Implement the user API
```

### 4. Maintain Task Context

Keep tasks.md updated:
```
Update fabric/specs/2024-01-15-auth/tasks.md
Mark "Create user model" as complete
```

Augment uses this to track progress.

### 5. Use Memory for Decisions

```
Remember: We decided to use Zod for validation instead of Joi

[Later...]
What validation library are we using?
```

## Augment-Specific Workflows

### Discovery-Driven Development

```
1. Find similar features in codebase
2. Analyze their implementation
3. Extract patterns
4. Apply to new feature
```

**Example:**
```
Find all form validation code in the codebase

[Augment shows examples]

Now implement validation for the user registration form
following the same pattern
```

### Consistency Enforcement

```
@fabric/standards/global/coding-style.md

Scan the codebase for files that don't follow our standards
and create a task list to fix them
```

### Intelligent Refactoring

```
Find all places where we're using the old authentication pattern
and create a migration plan to the new JWT-based approach
```

## Tips for Maximum Productivity

### 1. Start with Codebase Search

Before implementing anything new:
```
Show me how we've solved similar problems
```

### 2. Reference Standards Always

```
@fabric/standards/global/coding-style.md
[Every implementation request]
```

### 3. Use Rules for Expertise

```
@~/.augment/rules/backend-specialist.md  # For API work
@~/.augment/rules/frontend-specialist.md # For UI work
@~/.augment/rules/database-specialist.md # For DB work
```

### 4. Leverage Task Management

```
Create tasks for [feature]
Show task status
Mark task complete
```

### 5. Build Context Incrementally

```
@fabric/specs/2024-01-15-auth/spec.md
[Discuss approach]

@fabric/standards/global/coding-style.md
[Refine approach]

@~/.augment/rules/implementer.md
[Implement]
```

## Troubleshooting

### Rules Not Applied

**Issue:** Augment not using rules
**Solution:** Explicitly reference with `@~/.augment/rules/rule-name.md`

### Codebase Search Not Finding Code

**Issue:** Retrieval missing relevant code
**Solution:** Be more specific in query, use file paths or function names

### Context Lost

**Issue:** Augment forgets previous decisions
**Solution:** Use "Remember:" to explicitly save important decisions

## Next Steps

1. **Explore codebase retrieval** - Try searching for patterns
2. **Create custom rules** - Add project-specific guidance
3. **Use @ references** - Reference standards and specs
4. **Leverage task management** - Track progress in tasks.md
5. **Build memory** - Use "Remember:" for key decisions

## Resources

- [Augment Documentation](https://docs.augmentcode.com/)
- [Fabric Framework README](../../../README.md)
- [Workflow Guide](../../shared/default/RECOMMENDED_WORKFLOW.md)

