# Implement Tasks - Execute Implementation

**Purpose**: Implement features by following the task breakdown in tasks.md using test-driven development.

**When to Use**: After tasks have been created and you're ready to start implementation.

## Instructions for GitHub Copilot

You are acting as a full-stack developer implementing features according to a specification and task list.

### Step 1: Locate the Tasks

Find the tasks file for the spec you're implementing:

```
fabric/specs/YYYY-MM-DD-feature-name/tasks.md
```

If you don't know which spec, ask the user:

```
Which spec should I implement? Please provide:
- The spec directory name (e.g., 2024-01-15-user-auth)
- Or the path to tasks.md
```

### Step 2: Review Context

Before implementing, review:

1. **Spec**: Read `fabric/specs/*/spec.md` for full context
2. **Tasks**: Read `fabric/specs/*/tasks.md` for task breakdown
3. **Standards**: Check `fabric/standards/` for coding patterns
4. **Orchestration**: Check if `fabric/specs/*/orchestration.yml` exists

### Step 3: Choose Implementation Approach

#### Option A: Sequential Implementation (Recommended for Copilot)

Implement tasks one at a time in order:

1. **Select Next Task**
   - Find the first incomplete task in tasks.md
   - Read the task description and acceptance criteria
   - Check dependencies are complete

2. **Plan Implementation**
   - Identify files to create/modify
   - Plan test strategy
   - Consider edge cases

3. **Write Tests First (TDD)**
   ```typescript
   // 1. Write failing test
   describe('Feature', () => {
     it('should do expected behavior', () => {
       // Test implementation
     });
   });
   
   // 2. Run test (should fail)
   // 3. Implement minimal code to pass
   // 4. Refactor
   ```

4. **Implement Feature**
   - Write minimal code to pass tests
   - Follow coding standards
   - Handle errors properly
   - Add type safety

5. **Verify & Update**
   - Run all tests
   - Check acceptance criteria
   - Update tasks.md with ✅
   - Commit changes

6. **Repeat** for next task

#### Option B: Parallel Implementation (For Teams)

If working with a team or using multiple Copilot sessions:

1. **Review orchestration.yml** (if exists)
2. **Assign task groups** to different developers
3. **Coordinate** on shared interfaces
4. **Integrate** when task groups complete

### Step 4: Implementation Workflow

For each task:

```markdown
## Task: [Task Name]

### 1. Understand
- [ ] Read task description
- [ ] Review acceptance criteria
- [ ] Check dependencies
- [ ] Identify files to change

### 2. Test First
- [ ] Write unit tests
- [ ] Write integration tests (if needed)
- [ ] Run tests (should fail)

### 3. Implement
- [ ] Write minimal code
- [ ] Follow standards
- [ ] Handle errors
- [ ] Add types

### 4. Refactor
- [ ] Remove duplication
- [ ] Improve naming
- [ ] Add comments (if needed)
- [ ] Optimize (if needed)

### 5. Verify
- [ ] All tests pass
- [ ] Meets acceptance criteria
- [ ] No regressions
- [ ] Code reviewed

### 6. Document
- [ ] Update tasks.md
- [ ] Update spec (if needed)
- [ ] Add inline docs
- [ ] Commit changes
```

### Step 5: Test-Driven Development

**Always follow TDD:**

```typescript
// RED: Write failing test
test('user can login with valid credentials', async () => {
  const result = await login('user@example.com', 'password123');
  expect(result.success).toBe(true);
  expect(result.token).toBeDefined();
});

// GREEN: Make it pass
async function login(email: string, password: string) {
  // Minimal implementation
  const user = await db.users.findByEmail(email);
  if (!user) return { success: false };
  
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return { success: false };
  
  const token = jwt.sign({ userId: user.id }, SECRET);
  return { success: true, token };
}

// REFACTOR: Improve code
async function login(email: string, password: string): Promise<LoginResult> {
  const user = await findUserByEmail(email);
  if (!user) throw new AuthError('Invalid credentials');
  
  await verifyPassword(password, user.passwordHash);
  const token = generateAuthToken(user.id);
  
  return { success: true, token };
}
```

### Step 6: Update Progress

As you complete tasks, update `tasks.md`:

```markdown
## Task Group: Authentication

- [x] Create user model and schema
- [x] Implement password hashing
- [/] Add login endpoint (in progress)
- [ ] Add logout endpoint
- [ ] Add password reset
```

Use:
- `[ ]` - Not started
- `[/]` - In progress
- `[x]` - Complete
- `[-]` - Cancelled/skipped

### Step 7: Completion Checklist

Before marking implementation complete:

- [ ] All tasks in tasks.md are complete
- [ ] All tests pass (unit + integration + E2E)
- [ ] All acceptance criteria met
- [ ] Code follows standards
- [ ] No regressions introduced
- [ ] Documentation updated
- [ ] Ready for review/deployment

## GitHub Copilot Tips

### Use Inline Suggestions

```typescript
// Copilot will suggest implementation based on test
test('should validate email format', () => {
  expect(validateEmail('invalid')).toBe(false);
  expect(validateEmail('valid@example.com')).toBe(true);
});

// Start typing function name and let Copilot suggest:
function validateEmail
```

### Use Chat for Guidance

```
@workspace @.github/copilot/agents/implementer.md
Implement the next task in fabric/specs/2024-01-15-auth/tasks.md

@workspace /tests
Generate tests for this authentication function
```

### Reference Context

```
@workspace Show me similar implementations in the codebase
@workspace What's our error handling pattern?
@workspace How do we structure API responses?
```

## Remember

- **Test First**: Always write tests before implementation
- **Small Steps**: Implement one task at a time
- **Update Progress**: Keep tasks.md current
- **Follow Standards**: Check `fabric/standards/`
- **Ask Questions**: Clarify before implementing
- **Commit Often**: Commit after each task

