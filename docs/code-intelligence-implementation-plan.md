# Code Intelligence / Workspace Q&A Implementation Plan

## Current State

### Existing Capabilities
✅ **GitHub Integration** - Code search via `github_search_code` tool  
✅ **Project Attachment** - `attachedProjectId` for context  
✅ **RAG Documents** - Document chat with uploaded files  
✅ **Code-Aware Agents** - Specialized agents for code tasks  
✅ **Workspace Context** - `attachedWorkspaceIds` for RAG retrieval  

### Gaps
❌ **Explicit Code Question UI** - No "Ask about this code" entry points  
❌ **Code Context Visibility** - No file/line chips in launcher  
❌ **Project-Code Connection** - Weak visibility of repo association  
❌ **Inline Code References** - No `file:line` parsing in prompts  
❌ **Code Explanation Templates** - No guided code understanding flows  

---

## Implementation Phases

### C1: Code Context Chips in Launcher (1-2 days)

**Enhancement:** Extend `FabricAgentLauncher` to show code context

**New Props:**
```typescript
interface FabricAgentLaunchContext {
  // Existing...
  
  // NEW: Code context
  codeContext?: {
    filePath?: string;
    lineStart?: number;
    lineEnd?: number;
    repoName?: string;
    branch?: string;
    snippet?: string;  // Preview of selected code
  };
}
```

**UI Addition:**
```tsx
// In launcher, show code chips alongside project/feature/task
<div className="flex flex-wrap gap-2">
  {codeContext?.filePath && (
    <ContextChip 
      icon={<FileCodeIcon />}
      label={`${codeContext.filePath}:${codeContext.lineStart}`}
      tooltip="Code context from editor"
    />
  )}
</div>
```

**Usage:**
- Select code in editor → "Ask Fabric about this" → Launcher opens with code context

---

### C2: "Ask About This" Entry Points (2-3 days)

**Add context menu items:**

1. **StoryWorkspace Code View**
   - Right-click on code block → "Ask Fabric about this code"
   - Opens launcher with file/line context

2. **DocumentEditor (Raw Markdown)**
   - Select code fence → "Explain this code"
   - Opens launcher with snippet

3. **TaskModal Description**
   - Code blocks get "Ask Fabric" button overlay
   - Similar to @fabric mention

**Implementation:**
```typescript
// useCodeContext hook
export function useCodeContext() {
  const openWithCode = (codeContext: CodeContext, prompt?: string) => {
    openLauncher({
      ...baseContext,
      codeContext,
      prompt: prompt || `Explain this code:\n\n${codeContext.snippet}`,
    });
  };
  
  return { openWithCode };
}
```

---

### C3: Project-Repository Connection (1-2 days)

**Enhancement:** Show linked repositories in project context

**Database:** May need `Project.repositoryUrl` or `Project.githubIntegration`

**UI in Launcher:**
```tsx
// If project has GitHub connection
<ContextChip 
  icon={<GithubIcon />}
  label="Connected to fabric-portal repo"
  onClick={() => openRepoSettings()}
/>
```

**Agent Prompt Enhancement:**
```typescript
// When project has repo, inject into system prompt
if (attachedProjectId) {
  const project = await getProject(attachedProjectId);
  if (project.githubRepo) {
    systemPrompt += `\n\nThis project is connected to GitHub repository: ${project.githubRepo}`;
    systemPrompt += `\nYou can search code in this repository using the github_search_code tool.`;
  }
}
```

---

### C4: Code-Aware Quick Actions (2 days)

**Add suggested prompts when code context detected:**

```tsx
const CODE_QUICK_ACTIONS = [
  { label: "Explain this code", prompt: "Explain what this code does:" },
  { label: "Find bugs", prompt: "Review this code for potential bugs:" },
  { label: "Suggest improvements", prompt: "Suggest improvements for this code:" },
  { label: "Write tests", prompt: "Write unit tests for this code:" },
];

// Show in launcher when codeContext present
{codeContext && (
  <div className="flex gap-2 flex-wrap">
    {CODE_QUICK_ACTIONS.map(action => (
      <Button 
        key={action.label}
        variant="outline" 
        size="sm"
        onClick={() => setInput(action.prompt)}
      >
        {action.label}
      </Button>
    ))}
  </div>
)}
```

---

### C5: File:Line Reference Parsing (1 day)

**Enhancement:** Parse `file:line` references in user prompts

```typescript
// In FabricDirectChat
const CODE_REFERENCE_REGEX = /(\S+\.(?:js|ts|tsx|jsx|py|go|rs|java|cpp|c|h)):(\d+)(?:-(\d+))?/gi;

function extractCodeReferences(text: string): CodeReference[] {
  const matches = [...text.matchAll(CODE_REFERENCE_REGEX)];
  return matches.map(match => ({
    filePath: match[1],
    lineStart: parseInt(match[2]),
    lineEnd: match[3] ? parseInt(match[3]) : parseInt(match[2]),
  }));
}

// When sending message, if code references found:
// 1. Fetch code from GitHub (if repo connected)
// 2. Inject code snippet into context
// 3. Show preview to user
```

---

### C6: Code Explanation Skill (1-2 days)

**New Skill:** "Explain Code" template

```typescript
// packages/database/prisma/queries/skills.ts
const explainCodeSkill = {
  slug: "explain-code",
  name: "Explain Code",
  description: "Get a clear explanation of what code does",
  content: `Analyze the provided code and explain:
1. What the code does at a high level
2. Key functions/classes and their purposes
3. Any important patterns or techniques used
4. Potential edge cases or limitations

Code to explain:
{{code}}

Be concise but thorough.`,
};
```

**Quick Access:** `/explain` in chat triggers this skill

---

## Priority Order

| Phase | Effort | Impact | Priority |
|-------|--------|--------|----------|
| C1 Code Context Chips | 1-2 days | High | P1 |
| C2 "Ask About This" Entry Points | 2-3 days | High | P1 |
| C3 Project-Repo Connection | 1-2 days | Medium | P2 |
| C4 Code-Aware Quick Actions | 2 days | High | P1 |
| C5 File:Line Parsing | 1 day | Medium | P2 |
| C6 Code Explanation Skill | 1-2 days | Medium | P2 |

**Total P1:** 5-7 days  
**Total All:** 8-11 days

---

## After Code Intelligence

### Remaining Gaps (Lower Priority)

| Feature | Effort | Notes |
|---------|--------|-------|
| Richer Inline Mention UX | 3-5 days | Threaded agent responses in comments |
| Teams Implementation | 10-12 days | Deferred per feasibility spec |
| Slack Block Kit | 2-3 days | Rich formatting in Slack replies |

---

## Recommended Next Steps

1. **Start C1:** Add code context chips to launcher
2. **Parallel C2:** Add "Ask About This" entry points in StoryWorkspace
3. **Review:** Evaluate user feedback before C3-C6
4. **Iterate:** Based on usage, prioritize remaining phases

This gives you:
- Immediate code intelligence UX improvements
- Foundation for richer code interactions
- Data to inform further investment
