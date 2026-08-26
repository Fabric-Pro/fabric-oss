# Step 3: Verify Implementation

> **Usage**: Reference with `@.cursor/commands/3-verify-implementation.md` or copy into chat

---

## Workflow Instructions

Now that we've implemented all tasks in tasks.md, we must run final verifications and produce a verification report using the following MULTI-PHASE workflow.

### Step 1: Ensure tasks.md Has Been Updated

Verify that all tasks in `fabric/specs/[this-spec]/tasks.md` are marked as complete:
- All tasks should have `- [x]` instead of `- [ ]`
- All acceptance criteria should be checked off

### Step 2: Update Roadmap (If Applicable)

If this feature is part of a milestone in `fabric/product/roadmap.md`:
- Mark the relevant milestone as complete
- Update any related documentation

### Step 3: Run Entire Test Suite

Execute the full test suite using the detected package manager:

```bash
# Run all tests
[package-manager] test

# Run linting
[package-manager] run lint

# Type checking (if TypeScript)
[package-manager] run type-check

# Build verification
[package-manager] run build
```

### Step 4: Create Final Verification Report

Document the verification results:

```markdown
# Verification Report: [Feature Name]

## Date: YYYY-MM-DD

## Tasks Completed
- [x] All tasks in tasks.md marked complete
- [x] All acceptance criteria met

## Test Results
- **Total Tests**: [N]
- **Passing**: [N]
- **Failing**: [N]
- **Coverage**: [X]%

## Build Status
- **Lint**: ✅ Pass / ❌ Fail
- **Type Check**: ✅ Pass / ❌ Fail
- **Build**: ✅ Pass / ❌ Fail

## Files Changed
- [List of key files modified]

## Notes
[Any additional observations or follow-up items]
```

---

## Display Confirmation

Output the verification summary:

```
✅ Implementation Verified!

📊 VERIFICATION SUMMARY:
- Tasks: All complete
- Tests: [N] passing
- Build: ✅ Successful
- Coverage: [X]%

📁 Report saved to: fabric/specs/[this-spec]/verification-report.md

🎉 Feature implementation is complete and verified!
```

