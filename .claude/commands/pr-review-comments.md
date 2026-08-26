# Handle PR Review Comments

Review and respond to pull request comments by analyzing each one, fixing valid issues, and replying appropriately.

## Prerequisites

- You must have a GitHub repository context (owner and repo)
- There should be an open pull request with review comments

## Process

### Step 1: Get PR Review Comments

Ask the user for the following information if not already provided:
- **GitHub Owner**: Repository owner (username or organization)
- **Repository Name**: Repository name
- **Pull Request Number**: The PR number to review comments for

Example prompt if needed:
```
Please provide the following information:
1. GitHub repository owner
2. Repository name
3. Pull request number

For example: owner="facebook", repo="react", pullNumber=27063
```

### Step 2: Fetch and Analyze Comments

Once you have the information, fetch all review comments from the pull request using the GitHub MCP tools.

For EACH review comment:
1. **Read the comment** - Understand what the reviewer is pointing out
2. **Assess validity** - Determine if the comment raises a legitimate issue:
   - ✅ Valid: Points out bugs, security issues, style violations, performance problems, or legitimate architectural concerns
   - ❌ Invalid/Subjective: Personal preferences, nitpicks without substance, or already addressed
3. **Check if addressed** - Look at the current code to see if the issue was already fixed

### Step 3: Fix Valid Issues

For each valid comment that hasn't been fixed:

1. **Locate the problematic code** - Find the file and specific lines mentioned
2. **Understand the issue** - Read the comment and any context provided
3. **Implement the fix** - Make the necessary code changes
4. **Verify the fix** - Ensure it addresses the concern properly
5. **Run checks** - Execute type checks and linting to ensure no new issues introduced

### Step 4: Reply to Comments

After addressing the issues, reply to each comment appropriately:

**For valid, fixed comments:**
```
✅ Fixed! I've addressed this by [brief description of the fix].

Changes made:
- [specific change]
- [specific change]

The code now [how it improved/what was fixed].
```

**For invalid/subjective comments:**
```
I've reviewed this comment. This appears to be [reason], as [brief explanation].

[Optional: alternative approach or clarification]
```

**For already-addressed comments:**
Do NOT reply to comments that have already been fixed. The code changes speak for themselves, and adding unnecessary replies creates noise in the PR conversation. Simply skip these comments and move on to the next one.

### Step 5: Mark Comments as Resolved

After replying to a comment (for valid issues you fixed, or invalid/subjective comments you explained):

1. **Attempt to resolve via GitHub MCP** - If available, use the GitHub MCP tools to mark the comment thread as resolved
2. **Fallback to manual resolution** - If the MCP tool for resolving comments is not available, instruct the user:
   ```
   To mark this comment thread as resolved, please:
   1. Navigate to the PR on GitHub
   2. Find the comment thread
   3. Click "Resolve conversation" at the bottom of the thread
   ```

**Note**: Some GitHub review comment threads can be auto-marked as resolved if you push commits that address the feedback. This happens automatically for line-specific comments.

### Step 6: Summary

After handling all comments, display a summary:

```
✅ Review comments processed:

📝 Comments Analyzed: [X]
✅ Valid Issues Fixed: [X]
❌ Invalid/Subjective: [X]
⏭️ Already Addressed (skipped): [X]

Next steps:
- [ ] Review the changes made
- [ ] Run full test suite
- [ ] Request another review if needed
```

## Important Notes

- **Be thorough but fair** - Fix legitimate issues but don't over-interpret subjective feedback
- **Maintain code quality** - Ensure all fixes follow project standards (see AGENTS.md)
- **Test changes** - Run type checking and linting after making changes
- **Communicate clearly** - Be respectful and specific in your replies
- **Preserve context** - Keep track of which comments you've addressed

## Related Documentation

- See `AGENTS.md` for fabric-portal standards and patterns
- GitHub MCP tools for fetching PR data
- See repository's CONTRIBUTING.md for contribution guidelines
