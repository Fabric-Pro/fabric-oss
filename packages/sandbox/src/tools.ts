/**
 * Sandbox Tool Definitions for MCP Integration
 *
 * These tool definitions are used to register the sandbox
 * as an MCP server in Fabric's orchestrator.
 */

import type { SandboxToolDefinition } from "./types";

export const SANDBOX_TOOLS: SandboxToolDefinition[] = [
	{
		name: "createSession",
		description:
			"Create a new isolated sandbox session. Optionally clone a git repository. Returns a sessionId to use with other tools.",
		inputSchema: {
			type: "object",
			properties: {
				repoUrl: {
					type: "string",
					description:
						"Git repository URL to clone (e.g., https://github.com/owner/repo.git). GitHub token will be injected automatically if available.",
				},
				branch: {
					type: "string",
					description: "Branch to checkout (default: main)",
					default: "main",
				},
				workDir: {
					type: "string",
					description:
						"Working directory name inside /workspace (default: repo)",
					default: "repo",
				},
			},
		},
	},
	{
		name: "runClaude",
		description:
			"Run Claude Code AI to make code changes in the sandbox. Claude will analyze the task and apply necessary file modifications. Do NOT use this to commit changes - use the commit tool after.",
		inputSchema: {
			type: "object",
			properties: {
				sessionId: {
					type: "string",
					description: "Session ID from createSession",
				},
				task: {
					type: "string",
					description:
						"Detailed description of what changes to make. Be specific about files, functions, and expected behavior.",
				},
				context: {
					type: "string",
					description:
						"Additional context about the codebase or requirements",
				},
				systemPrompt: {
					type: "string",
					description: "Custom system prompt for Claude (optional)",
				},
				timeout: {
					type: "number",
					description: "Timeout in seconds (default: 300, max: 600)",
					default: 300,
				},
			},
			required: ["sessionId", "task"],
		},
	},
	{
		name: "getDiff",
		description:
			"Get the git diff showing all current changes in the sandbox. Use this before requesting approval for code changes.",
		inputSchema: {
			type: "object",
			properties: {
				sessionId: {
					type: "string",
					description: "Session ID from createSession",
				},
				staged: {
					type: "boolean",
					description:
						"If true, show only staged changes (default: false)",
					default: false,
				},
			},
			required: ["sessionId"],
		},
	},
	{
		name: "commit",
		description:
			"Commit all current changes in the sandbox. Call this after user approves the diff.",
		inputSchema: {
			type: "object",
			properties: {
				sessionId: {
					type: "string",
					description: "Session ID from createSession",
				},
				message: {
					type: "string",
					description: "Commit message describing the changes",
				},
			},
			required: ["sessionId", "message"],
		},
	},
	{
		name: "push",
		description:
			"Push committed changes to the remote repository. Call this after commit.",
		inputSchema: {
			type: "object",
			properties: {
				sessionId: {
					type: "string",
					description: "Session ID from createSession",
				},
				remote: {
					type: "string",
					description: "Remote name (default: origin)",
					default: "origin",
				},
				branch: {
					type: "string",
					description: "Branch to push to (default: current branch)",
				},
				force: {
					type: "boolean",
					description: "Force push (use with caution)",
					default: false,
				},
			},
			required: ["sessionId"],
		},
	},
	{
		name: "exec",
		description:
			"Execute a shell command in the sandbox. Use for running tests, builds, or other commands.",
		inputSchema: {
			type: "object",
			properties: {
				sessionId: {
					type: "string",
					description: "Session ID from createSession",
				},
				command: {
					type: "string",
					description: "Shell command to execute",
				},
				cwd: {
					type: "string",
					description:
						"Working directory relative to session workDir (optional)",
				},
				timeout: {
					type: "number",
					description: "Timeout in seconds (default: 60, max: 300)",
					default: 60,
				},
			},
			required: ["sessionId", "command"],
		},
	},
	{
		name: "readFile",
		description: "Read the contents of a file in the sandbox",
		inputSchema: {
			type: "object",
			properties: {
				sessionId: {
					type: "string",
					description: "Session ID from createSession",
				},
				path: {
					type: "string",
					description: "File path relative to session workDir",
				},
			},
			required: ["sessionId", "path"],
		},
	},
	{
		name: "writeFile",
		description: "Write content to a file in the sandbox",
		inputSchema: {
			type: "object",
			properties: {
				sessionId: {
					type: "string",
					description: "Session ID from createSession",
				},
				path: {
					type: "string",
					description: "File path relative to session workDir",
				},
				content: {
					type: "string",
					description: "Content to write to the file",
				},
			},
			required: ["sessionId", "path", "content"],
		},
	},
	{
		name: "destroySession",
		description:
			"Destroy a sandbox session and clean up resources. Always call this when done with a session.",
		inputSchema: {
			type: "object",
			properties: {
				sessionId: {
					type: "string",
					description: "Session ID from createSession",
				},
			},
			required: ["sessionId"],
		},
	},
];

/**
 * Workflow guidance for using sandbox tools
 * This is injected into the agent's system prompt
 */
export const SANDBOX_WORKFLOW_GUIDANCE = `## Code Change Workflow (Sandbox + GitHub)

For ANY task requiring code changes, follow this exact flow:

1. **Clone the repository**:
   \`\`\`
   Sandbox__createSession({ repoUrl: "https://github.com/owner/repo.git", branch: "main" })
   \`\`\`
   This returns a sessionId to use with all subsequent calls.

2. **Create a feature branch** (REQUIRED - never commit directly to main):
   \`\`\`
   Sandbox__exec({ sessionId, command: "git checkout -b feature/descriptive-branch-name" })
   \`\`\`
   Use a descriptive branch name like "feature/add-login" or "fix/typo-in-readme".

3. **Make changes** using Claude Code:
   \`\`\`
   Sandbox__runClaude({ sessionId, task: "Detailed description of what to change" })
   \`\`\`

4. **Get the diff** (REQUIRED before approval):
   \`\`\`
   Sandbox__getDiff({ sessionId })
   \`\`\`
   This returns the diff and stats (files, additions, deletions).

5. **Request approval** with the diff preview:
   \`\`\`
   request_approval({
     tool: "GitHub__create_pr",
     action: "Create Pull Request",
     data: {
       owner, repo, baseBranch: "main", headBranch: "feature/your-branch",
       title: "PR title", body: "Description",
       diff: <diff from getDiff>,
       stats: <stats from getDiff>
     }
   })
   \`\`\`

6. **After user approval**, commit, push, AND create PR (ALL THREE REQUIRED):
   \`\`\`
   Sandbox__commit({ sessionId, message: "Commit message" })
   Sandbox__push({ sessionId, branch: "feature/your-branch" })
   GitHub__create_pr({ owner, repo, title, head: "feature/your-branch", base: "main", body })
   \`\`\`

7. **ALWAYS destroy the session** when done:
   \`\`\`
   Sandbox__destroySession({ sessionId })
   \`\`\`

IMPORTANT RULES:
- ALWAYS create a feature branch before making changes
- NEVER commit directly to main/master
- ALWAYS call getDiff before requesting approval
- ALWAYS destroy the session when done (success or failure)
- Include diff and stats in approval data for user review`;
