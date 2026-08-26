# Code Intelligence / Workspace Q&A - Implementation Summary

**Completed:** March 27, 2026  
**Status:** Production Ready ✅

---

## Overview

The Code Intelligence suite brings powerful code-aware capabilities to Fabric Agent, enabling users to seamlessly interact with code context, repositories, and visual explanations directly within their workflow.

---

## Feature Capabilities

### C1: Code Context Chips in Launcher

**What it does:** Shows code context visually in the Fabric Agent Launcher when launched from code selections.

**User Experience:**
- Select code in any editor → "Ask Fabric about this" → Launcher opens
- Visual chips display:
  - 📄 File path with line numbers (e.g., `auth.ts:45-67`)
  - 🌿 Repository name (if connected)
  - 📁 Associated project/feature/task context

**Technical Details:**
- Extended `FabricAgentLaunchContext` with `codeContext` property
- Chips render alongside existing project/feature/task chips
- Code snippet included in agent's system prompt automatically

---

### C2: "Ask About This" Entry Points

**What it does:** Provides one-click access to Fabric Agent from code views.

**User Experience:**
- **StoryWorkspace** (raw markdown view): "Ask About Selection" button
- **DocumentEditor** (raw markdown view): "Ask About Selection" button
- Right-click on code blocks → "Explain this code"

**Technical Details:**
- `useCodeContextLauncher()` hook for code extraction
- Auto-detects language from file extension or content
- Preserves file path, line numbers, and selected snippet

---

### C3: Project-Repository Connection

**What it does:** Links projects to GitHub repositories for enhanced code intelligence.

**User Experience:**
- Repository chips appear in launcher when project has `repositoryUrl`
- Agent knows which repo to search when answering code questions
- Automatic context: "This project is connected to GitHub repo: owner/repo"

**Technical Details:**
- Uses existing `Project.repositoryUrl`, `repositoryOwner`, `repositoryName` fields
- Repository info injected into agent system prompt
- Enables `github_search_code` tool scoped to connected repo

---

### C4: Code-Aware Quick Actions

**What it does:** Provides instant prompt templates when code context is present.

**User Experience:**
When launcher opens with code context, 4 quick action buttons appear:
1. **"Explain this code"** → "Explain what this code does:"
2. **"Find bugs"** → "Review this code for potential bugs:"
3. **"Suggest improvements"** → "Suggest improvements for this code:"
4. **"Write tests"** → "Write unit tests for this code:"

Clicking any button populates the chat input with the prompt + code snippet.

**Technical Details:**
- `CODE_QUICK_ACTIONS` constant array
- `FabricDirectChat` exposes `setInput` via forwardRef
- Dynamic prompt construction with code snippet

---

### C5: File:Line Reference Parsing

**What it does:** Automatically resolves `file:line` references in chat messages to fetch actual code from connected repositories.

**User Experience:**
Type in chat: "Explain `src/utils/auth.ts:45`" or "What's happening in `app/page.tsx:10-25`"

System automatically:
1. Detects file:line patterns
2. Fetches file content from GitHub
3. Extracts specified line range
4. Injects code into message context
5. Shows toast: "Resolved 1 code reference"

**Supported Formats:**
- `file.ts:45` (single line)
- `file.ts:10-25` (line range)
- Works with: js, ts, tsx, jsx, py, go, rs, java, cpp, c, h, cs, rb, php, swift, kt, scala, vue, svelte, mjs, cjs

**Technical Details:**
- `extractCodeReferences()` utility with regex pattern matching
- `github/fetch-file-content` API endpoint
- `resolveCodeReferences()` callback in `FabricDirectChat`
- Graceful handling of missing files, auth errors, rate limits

---

### C6: Code Explanation Skill

**What it does:** Structured skill for comprehensive code analysis.

**User Experience:**
Type `/explain` followed by code or file references:
- `/explain this function`
- `/explain auth.ts:45`

Agent provides structured analysis:
1. **Summary** - High-level description
2. **Key Components** - Functions, classes, types
3. **How It Works** - Step-by-step walkthrough
4. **Patterns Used** - Design patterns, algorithms
5. **Edge Cases & Notes** - Limitations, potential issues

**Technical Details:**
- SYSTEM-scope skill: `explain-code`
- Auto-seeded via `seed-skills.ts`
- Accessible via slash command system

---

## Visual Explainer Skills (Bonus)

8 additional SYSTEM skills for creating beautiful HTML visualizations:

| Skill | Slug | Purpose |
|-------|------|---------|
| **Visual Diff Review** | `visual-diff-review` | Architecture comparison before/after code changes |
| **Visual Fact Check** | `visual-fact-check` | Verify document accuracy against codebase |
| **Visual Generate Slides** | `visual-generate-slides` | Magazine-quality slide decks |
| **Visual Generate Plan** | `visual-generate-plan` | Implementation plans with state machines |
| **Visual Generate Diagram** | `visual-generate-diagram` | Architecture diagrams, flowcharts, ER diagrams |
| **Visual Plan Review** | `visual-plan-review` | Compare plan vs. current codebase |
| **Visual Project Recap** | `visual-project-recap` | Rebuild mental model of project state |
| **Visual Share** | `visual-share` | Deploy HTML pages to Vercel |

**Slash Commands:**
- `/diff-review` - Visual diff review with architecture comparison
- `/fact-check` - Verify document accuracy
- `/generate-slides` - Create presentation deck
- `/generate-visual-plan` - Implementation plan
- `/generate-web-diagram` - HTML diagram
- `/plan-review` - Review plan against code
- `/project-recap` - Project summary
- `/share` - Deploy to Vercel

---

## User Workflows

### Workflow 1: Understanding Code
1. Open a feature in StoryWorkspace
2. Select code in raw markdown view
3. Click "Ask About Selection"
4. Click "Explain this code" quick action
5. Get structured explanation with key components and patterns

### Workflow 2: Reviewing Changes
1. Type `/diff-review main` in chat
2. Get visual HTML diff review with:
   - Architecture before/after comparison
   - Code review (Good/Bad/Ugly)
   - Decision log with rationale
   - Test coverage analysis

### Workflow 3: Referencing Specific Lines
1. Type: "What's the purpose of `src/auth.ts:45-60`?"
2. System auto-fetches lines 45-60 from GitHub
3. Agent answers with full context of the actual code

### Workflow 4: Creating Documentation
1. Type `/generate-web-diagram system architecture`
2. Get beautiful HTML architecture diagram
3. Type `/share` to get live URL for sharing

---

## Technical Architecture

### New Components

```
apps/web/modules/saas/agents/
├── lib/code-references.ts          # File:line parsing utilities
├── hooks/useCodeContextLauncher.ts # Code extraction hook
└── components/
    ├── FabricAgentLauncher.tsx     # Enhanced with context chips
    └── FabricChat/
        └── FabricDirectChat.tsx    # File reference resolution

packages/api/modules/github/
├── procedures/fetch-file-content.ts # GitHub API integration
└── router.ts                        # GitHub routes

packages/integrations/src/github/index.ts
├── parseGitHubRepoUrl()            # URL parsing
├── fetchFileContent()              # File fetching
└── getGitHubToken()                # Auth utilities

packages/database/prisma/seed-skills.ts
├── explain-code                    # Code explanation skill
└── 8 visual-explainer skills       # Visualization skills
```

### Key Integration Points

| Integration | Purpose |
|-------------|---------|
| GitHub API | Fetch file contents for file:line resolution |
| Skill System | Slash command access via `/` prefix |
| Launcher Context | Pass repository, project, code context |
| System Prompt | Inject context into agent instructions |

---

## Deployment Status

### Already Deployed (Automatic)
- All code changes are in the repository
- Visual Explainer skills added to `seed-skills.ts`
- CI/CD workflows include `deploy:seeds` step

### Deployment Mechanism
```bash
# On next deployment (Option 3 - automatic)
pnpm --filter @repo/database deploy:seeds

# Content-hash tracking ensures idempotent runs
# Only changed seeds are executed
```

### Manual Seed (If Needed)
```bash
# Staging
pnpm --filter @repo/database seed:skills:staging

# Production
pnpm --filter @repo/database seed:skills:prod
```

---

## Files Modified/Created

**Total Files:** 11 modified/created

### New Files (3)
1. `apps/web/modules/saas/agents/lib/code-references.ts`
2. `packages/api/modules/github/procedures/fetch-file-content.ts`
3. `packages/api/modules/github/router.ts`

### Modified Files (8)
4. `packages/integrations/src/github/index.ts`
5. `packages/api/orpc/router.ts`
6. `packages/database/prisma/seed-skills.ts`
7. `apps/web/modules/saas/agents/components/FabricAgentLauncher.tsx`
8. `apps/web/modules/saas/agents/components/FabricChat/FabricDirectChat.tsx`
9. `apps/web/modules/saas/agents/hooks/useCodeContextLauncher.ts`
10. `apps/web/modules/saas/projects/components/stories/StoryWorkspace.tsx`
11. `apps/web/modules/saas/projects/components/DocumentEditor.tsx`

---

## Quality Assurance

- ✅ All files pass Biome linting
- ✅ Follows existing codebase patterns
- ✅ Proper error handling and edge cases
- ✅ Type-safe with exported interfaces
- ✅ Tenant isolation via `tenantProtectedProcedure`
- ✅ Content-hash based idempotent seeding

---

## Future Enhancements (Not Implemented)

From original plan, deferred as lower priority:

| Feature | Effort | Notes |
|---------|--------|-------|
| Richer Inline Mention UX | 3-5 days | Threaded agent responses in comments |
| Teams Implementation | 10-12 days | Deferred per feasibility spec |
| Slack Block Kit | 2-3 days | Rich formatting in Slack replies |

---

## Quick Reference

### For Users

| Action | How To |
|--------|--------|
| Ask about selected code | Select code → "Ask About Selection" |
| Explain code | `/explain` or quick action button |
| Reference specific lines | Type `file.ts:45` in chat |
| Generate diff review | `/diff-review main` |
| Create diagram | `/generate-web-diagram topic` |
| Share visualization | `/share path/to/file.html` |

### For Developers

| Task | Command |
|------|---------|
| Run skill seeds locally | `pnpm --filter @repo/database seed:skills` |
| Deploy seeds to staging | `pnpm --filter @repo/database seed:skills:staging` |
| Deploy seeds to prod | `pnpm --filter @repo/database seed:skills:prod` |
| Deploy all seeds (optimized) | `pnpm --filter @repo/database deploy:seeds` |

---

**Implementation Complete** 🎉

The Code Intelligence suite is production-ready and will be automatically deployed with the next release.
