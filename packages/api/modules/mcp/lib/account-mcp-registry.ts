/**
 * Account-Based MCP Registry
 *
 * This module provides a pluggable registry for "hosted" MCP servers that are
 * associated with user accounts (e.g., Gmail, Google Docs, GitHub).
 *
 * Unlike remote MCP servers that require direct HTTP connections, account-based
 * MCPs use the user's OAuth credentials to access APIs directly.
 *
 * Pattern inspired by Weft's AccountMCPRegistry.
 *
 * @example
 * ```typescript
 * // Get available MCPs for Google account
 * const googleMcps = getAccountMcps("google");
 *
 * // Get specific MCP definition
 * const gmailMcp = getMcpDefinition("google", "gmail");
 * ```
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Credential authentication type
 */
type CredentialAuthType = "oauth" | "api_key" | "none";

/**
 * URL pattern for link enrichment
 */
export interface MCPUrlPattern {
	/** Pattern to match (e.g., "https://mail.google.com/*") */
	pattern: string;
	/** Tool to invoke for this URL */
	tool?: string;
	/** Description of what this pattern handles */
	description?: string;
}

/**
 * Tool schema for MCP
 */
export interface MCPToolSchema {
	/** Tool name */
	name: string;
	/** Tool description */
	description?: string;
	/** JSON Schema for input parameters */
	inputSchema: Record<string, unknown>;
	/** Fields requiring user approval before execution */
	approvalRequiredFields?: string[];
}

/**
 * MCP definition for an account-based service
 */
export interface MCPDefinition {
	/** Unique identifier (e.g., "gmail") */
	id: string;
	/** Display name (e.g., "Gmail") */
	name: string;
	/** Server name for identifiers */
	serverName: string;
	/** Description of capabilities */
	description: string;
	/** Icon URL or emoji */
	icon?: string;
	/** URL patterns this MCP can handle */
	urlPatterns?: MCPUrlPattern[];
	/** Pre-defined tools (for UI display before connection) */
	tools?: MCPToolSchema[];
	/** Guidance for AI workflows */
	workflowGuidance?: string;
	/** Required scopes for OAuth */
	requiredScopes?: string[];
	/** Whether this MCP is currently available */
	available?: boolean;
	/** Coming soon flag */
	comingSoon?: boolean;
}

/**
 * Account definition for a service provider
 */
export interface AccountDefinition {
	/** Unique identifier (e.g., "google") */
	id: string;
	/** Display name (e.g., "Google") */
	name: string;
	/** Credential type key (e.g., "google_oauth") */
	credentialType: string;
	/** Authentication type */
	authType: CredentialAuthType;
	/** Icon URL or identifier */
	icon?: string;
	/** MCPs available for this account */
	mcps: MCPDefinition[];
	/** OAuth scopes required at account level */
	baseScopes?: string[];
	/** Whether this account's MCPs are always enabled (no auth required) */
	alwaysEnabled?: boolean;
	/** Environment binding keys required (e.g., ['SANDBOX']) */
	envBindingKeys?: string[];
	/** Additional credential keys needed from user config */
	additionalCredentialKeys?: string[];
}

// ============================================================================
// Workflow Guidance Constants
// ============================================================================

const SANDBOX_WORKFLOW_GUIDANCE = `## Code Change Workflow (Sandbox + GitHub)
For ANY task requiring code changes, you MUST use Sandbox. Here's the exact flow:

1. **Clone the repository**:
   \`\`\`
   Sandbox__createSession({ repoUrl: "https://github.com/owner/repo.git", branch: "main" })
   \`\`\`
   This returns a sessionId you'll use for all subsequent calls.

2. **Create a feature branch** (REQUIRED - never commit directly to main):
   \`\`\`
   Sandbox__exec({ sessionId: "...", command: "git checkout -b feature/descriptive-branch-name" })
   \`\`\`
   Use a descriptive branch name like "feature/improve-readme" or "fix/typo-in-docs".

3. **Make changes** - Use runClaude to let Claude Code make the edits:
   \`\`\`
   Sandbox__runClaude({ sessionId: "...", task: "description of what to change" })
   \`\`\`

4. **Get the diff** - REQUIRED before approval:
   \`\`\`
   Sandbox__getDiff({ sessionId: "..." })
   \`\`\`
   This returns the diff string and stats (files, additions, deletions counts).

5. **Request PR approval** - Include the diff from step 4:
   \`\`\`
   request_approval({
     tool: "GitHub__create_pull_request",
     action: "Create Pull Request",
     data: {
       owner, repo, base: "main", head: "feature/your-branch-name",
       title, body,
       diff: <diff from getDiff>,
       stats: <stats from getDiff>
     }
   })
   \`\`\`
   IMPORTANT: You MUST extract the diff and stats from the getDiff result.

6. **After user approval** - Commit, push, AND create PR (ALL THREE REQUIRED):
   \`\`\`
   Sandbox__commit({ sessionId, message: "..." })
   Sandbox__push({ sessionId, branch: "feature/your-branch-name" })
   GitHub__create_pull_request({ owner, repo, title, head: "feature/your-branch-name", base: "main", body })
   \`\`\`
   **CRITICAL: You MUST call GitHub__create_pull_request after pushing. The task is NOT complete until the PR is created.**

7. **ALWAYS destroy the session** when done (success or failure):
   \`\`\`
   Sandbox__destroySession({ sessionId })
   \`\`\`

IMPORTANT RULES:
- createSession requires repoUrl parameter to clone the repo
- ALWAYS create a feature branch before making changes
- Do NOT call request_approval without first calling getDiff
- The "diff" and "stats" fields in approval data are REQUIRED
- Use the SAME branch name in: checkout, push, and create_pr
- After approval, you MUST: commit → push → create_pr (in that order)
- ALWAYS destroy the session when done`;

const GMAIL_WORKFLOW_GUIDANCE = `## Gmail Workflow
Always request approval before sending emails.

**Sending an email:**
\`\`\`
request_approval({
  tool: "Gmail__sendEmail",
  action: "Send Email",
  data: {
    to: "recipient@example.com",
    subject: "Email Subject",
    body: "Email body content..."
  }
})
\`\`\`
After approval, call: \`Gmail__sendEmail({ to: "...", subject: "...", body: "..." })\``;

const GOOGLE_DOCS_WORKFLOW_GUIDANCE = `## Google Docs Workflow
**Creating a new document:**
\`\`\`
request_approval({
  tool: "Google_Docs__createDocument",
  action: "Create Document",
  data: {
    title: "Document Title",
    content: "The full document content to create..."
  }
})
\`\`\`
After approval, call: \`Google_Docs__createDocument({ title: "...", content: "..." })\`

**Modifying existing documents:**
1. Get current content first: \`Google_Docs__getDocument({ documentId: "..." })\`
2. Request approval with both old and new content
3. After approval, call the actual tool`;

const GOOGLE_SHEETS_WORKFLOW_GUIDANCE = `## Google Sheets Workflow
For creating or modifying spreadsheets, ALWAYS request approval first.

**Creating a new spreadsheet:**
\`\`\`
request_approval({
  tool: "Google_Sheets__createSpreadsheet",
  action: "Create Spreadsheet",
  data: {
    title: "Spreadsheet Title",
    rows: [
      ["Column 1", "Column 2", "Column 3"],
      ["Value 1", "Value 2", "Value 3"],
    ]
  }
})
\`\`\`

**Modifying an existing spreadsheet:**
1. Get current data: \`Google_Sheets__getSheetData({ spreadsheetId: "...", range: "Sheet1" })\`
2. Request approval with currentRows and newRows
3. After approval, call the actual tool`;

const GITHUB_WORKFLOW_GUIDANCE = `## GitHub Workflow
Use GitHub tools for repository operations, issues, and pull requests.

**Reading repository info:**
\`\`\`
GitHub__get_repository({ owner: "...", repo: "..." })
GitHub__list_issues({ owner: "...", repo: "...", state: "open" })
GitHub__get_pull_request({ owner: "...", repo: "...", pull_number: 123 })
\`\`\`

**Creating a Pull Request (after Sandbox changes):**
After using Sandbox to commit and push changes, create the PR:
\`\`\`
GitHub__create_pull_request({
  owner: "...",
  repo: "...",
  title: "PR title",
  head: "feature/branch-name",
  base: "main",
  body: "Description of changes..."
})
\`\`\`
This returns the PR URL which should be stored as the task artifact.`;

const MICROSOFT_TEAMS_WORKFLOW_GUIDANCE = `## Microsoft Teams Workflow
Use Microsoft Teams tools to search and access Teams messages, channels, and shared files.
These tools query Microsoft Graph API in real-time using the user's connected Microsoft account.

**Listing the user's teams:**
\`\`\`
Microsoft_Teams__list_teams({})
\`\`\`
Returns all Teams the user has joined with their IDs, names, and descriptions.

**Listing channels in a team:**
\`\`\`
Microsoft_Teams__list_channels({ teamId: "team-id-here" })
\`\`\`
Returns channels in the specified team with their IDs, names, and types.

**Searching messages across Teams:**
\`\`\`
Microsoft_Teams__search_messages({ query: "project deadline", limit: 20 })
\`\`\`
Searches for messages containing the query across all accessible Teams channels and chats.

**Listing recent messages in a channel:**
\`\`\`
Microsoft_Teams__list_messages({ teamId: "team-id", channelId: "channel-id", limit: 50 })
\`\`\`
Returns recent messages from a specific channel, ordered by most recent first.

**Getting files shared in a channel:**
\`\`\`
Microsoft_Teams__get_shared_files({ teamId: "team-id", channelId: "channel-id" })
\`\`\`
Returns files that have been shared in the channel's SharePoint folder.

**Listing the user's direct and group chats:**
\`\`\`
Microsoft_Teams__list_chats({ limit: 50 })
\`\`\`
Returns direct (1:1) and group chats with their IDs. These are NOT Team channels.

**Getting messages from a direct or group chat:**
\`\`\`
Microsoft_Teams__get_chat_messages({ chatId: "chat-id-here", limit: 50 })
\`\`\`
Returns messages from a specific direct or group chat. Use chat IDs from list_chats.

**IMPORTANT: Teams vs Chats distinction:**
- **Team channels**: Use list_teams → list_channels → list_messages (teamId + channelId)
- **Group/direct chats**: Use list_chats → get_chat_messages (chatId)
- Do NOT pass a group chat ID to list_messages — they are different APIs

**Best Practices:**
- Always start by listing teams if you don't know the team ID
- Use search_messages for finding specific content across all Teams and chats
- Use list_messages for browsing recent Team channel activity
- Use get_chat_messages for reading group or direct chat history
- The user must have Microsoft connected in Settings for these tools to work`;

// ============================================================================
// Registry Data
// ============================================================================

/**
 * Registry of account-based MCP providers
 */
export const ACCOUNT_REGISTRY: AccountDefinition[] = [
	// Sandbox - Always enabled for code execution
	{
		id: "sandbox",
		name: "Code Sandbox",
		credentialType: "none",
		authType: "none",
		icon: "terminal",
		alwaysEnabled: true,
		envBindingKeys: ["SANDBOX_WORKER_URL", "SANDBOX_AUTH_SECRET"],
		additionalCredentialKeys: ["githubToken", "anthropicApiKey"],
		mcps: [
			{
				id: "sandbox",
				name: "Sandbox",
				serverName: "Sandbox",
				description:
					"Execute code in isolated Cloudflare sandbox environment",
				icon: "terminal",
				available: true,
				tools: [
					{
						name: "createSession",
						description:
							"Create a new isolated sandbox session. Optionally clone a git repository.",
						inputSchema: {
							type: "object",
							properties: {
								repoUrl: {
									type: "string",
									description: "Git repository URL to clone",
								},
								branch: {
									type: "string",
									description:
										"Branch to checkout (default: main)",
								},
								workDir: {
									type: "string",
									description: "Working directory name",
								},
							},
						},
					},
					{
						name: "runClaude",
						description:
							"Run Claude Code AI to make code changes in the sandbox",
						inputSchema: {
							type: "object",
							properties: {
								sessionId: {
									type: "string",
									description:
										"Session ID from createSession",
								},
								task: {
									type: "string",
									description:
										"Description of what changes to make",
								},
								context: {
									type: "string",
									description: "Additional context",
								},
								timeout: {
									type: "number",
									description:
										"Timeout in seconds (default: 300)",
								},
							},
							required: ["sessionId", "task"],
						},
					},
					{
						name: "getDiff",
						description:
							"Get the git diff showing all current changes",
						inputSchema: {
							type: "object",
							properties: {
								sessionId: {
									type: "string",
									description: "Session ID",
								},
								staged: {
									type: "boolean",
									description: "Show only staged changes",
								},
							},
							required: ["sessionId"],
						},
					},
					{
						name: "commit",
						description: "Commit all current changes",
						inputSchema: {
							type: "object",
							properties: {
								sessionId: {
									type: "string",
									description: "Session ID",
								},
								message: {
									type: "string",
									description: "Commit message",
								},
							},
							required: ["sessionId", "message"],
						},
					},
					{
						name: "push",
						description:
							"Push committed changes to remote repository",
						inputSchema: {
							type: "object",
							properties: {
								sessionId: {
									type: "string",
									description: "Session ID",
								},
								remote: {
									type: "string",
									description:
										"Remote name (default: origin)",
								},
								branch: {
									type: "string",
									description: "Branch to push to",
								},
								force: {
									type: "boolean",
									description: "Force push",
								},
							},
							required: ["sessionId"],
						},
					},
					{
						name: "exec",
						description: "Execute a shell command in the sandbox",
						inputSchema: {
							type: "object",
							properties: {
								sessionId: {
									type: "string",
									description: "Session ID",
								},
								command: {
									type: "string",
									description: "Shell command to execute",
								},
								cwd: {
									type: "string",
									description: "Working directory",
								},
								timeout: {
									type: "number",
									description: "Timeout in seconds",
								},
							},
							required: ["sessionId", "command"],
						},
					},
					{
						name: "readFile",
						description: "Read a file from the sandbox",
						inputSchema: {
							type: "object",
							properties: {
								sessionId: {
									type: "string",
									description: "Session ID",
								},
								path: {
									type: "string",
									description: "File path",
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
									description: "Session ID",
								},
								path: {
									type: "string",
									description: "File path",
								},
								content: {
									type: "string",
									description: "File content",
								},
							},
							required: ["sessionId", "path", "content"],
						},
					},
					{
						name: "destroySession",
						description:
							"Destroy a sandbox session and clean up resources",
						inputSchema: {
							type: "object",
							properties: {
								sessionId: {
									type: "string",
									description: "Session ID",
								},
							},
							required: ["sessionId"],
						},
					},
				],
				workflowGuidance: SANDBOX_WORKFLOW_GUIDANCE,
			},
		],
	},
	{
		id: "google",
		name: "Google",
		credentialType: "google_oauth",
		authType: "oauth",
		icon: "google",
		baseScopes: ["openid", "email", "profile"],
		mcps: [
			{
				id: "gmail",
				name: "Gmail",
				serverName: "Gmail",
				description: "Read, send, and search emails in Gmail",
				icon: "mail",
				available: false,
				comingSoon: true,
				requiredScopes: [
					"https://www.googleapis.com/auth/gmail.readonly",
					"https://www.googleapis.com/auth/gmail.send",
					"https://www.googleapis.com/auth/gmail.modify",
				],
				urlPatterns: [
					{
						pattern: "https://mail.google.com/*",
						description: "Gmail web interface",
					},
				],
				tools: [
					{
						name: "listMessages",
						description:
							"List email messages with optional filters",
						inputSchema: {
							type: "object",
							properties: {
								maxResults: { type: "number", default: 10 },
								query: {
									type: "string",
									description: "Search query",
								},
								labelIds: {
									type: "array",
									items: { type: "string" },
									description: "Filter by label IDs",
								},
							},
						},
					},
					{
						name: "getMessage",
						description: "Get a specific email message",
						inputSchema: {
							type: "object",
							properties: {
								messageId: {
									type: "string",
									description: "Message ID",
								},
							},
							required: ["messageId"],
						},
					},
					{
						name: "sendEmail",
						description: "Send an email",
						inputSchema: {
							type: "object",
							properties: {
								to: {
									type: "string",
									description: "Recipient email",
								},
								subject: {
									type: "string",
									description: "Email subject",
								},
								body: {
									type: "string",
									description: "Email body",
								},
								cc: {
									type: "string",
									description: "CC recipients",
								},
								bcc: {
									type: "string",
									description: "BCC recipients",
								},
							},
							required: ["to", "subject", "body"],
						},
						approvalRequiredFields: ["to", "subject"],
					},
				],
				workflowGuidance: GMAIL_WORKFLOW_GUIDANCE,
			},
			{
				id: "google-docs",
				name: "Google Docs",
				serverName: "GoogleDocs",
				description: "Create, read, and edit Google Documents",
				icon: "file-text",
				available: false,
				comingSoon: true,
				requiredScopes: [
					"https://www.googleapis.com/auth/documents",
					"https://www.googleapis.com/auth/drive.file",
				],
				urlPatterns: [
					{
						pattern: "https://docs.google.com/document/*",
						description: "Google Docs documents",
					},
				],
				tools: [
					{
						name: "getDocument",
						description: "Get a Google Doc by ID",
						inputSchema: {
							type: "object",
							properties: {
								documentId: {
									type: "string",
									description: "Document ID",
								},
							},
							required: ["documentId"],
						},
					},
					{
						name: "createDocument",
						description: "Create a new Google Doc",
						inputSchema: {
							type: "object",
							properties: {
								title: {
									type: "string",
									description: "Document title",
								},
								content: {
									type: "string",
									description: "Initial content",
								},
							},
							required: ["title"],
						},
					},
				],
				workflowGuidance: GOOGLE_DOCS_WORKFLOW_GUIDANCE,
			},
			{
				id: "google-sheets",
				name: "Google Sheets",
				serverName: "GoogleSheets",
				description: "Create, read, and edit Google Spreadsheets",
				icon: "table",
				available: false,
				comingSoon: true,
				requiredScopes: [
					"https://www.googleapis.com/auth/spreadsheets",
					"https://www.googleapis.com/auth/drive.file",
				],
				urlPatterns: [
					{
						pattern: "https://docs.google.com/spreadsheets/*",
						description: "Google Sheets spreadsheets",
					},
				],
				tools: [
					{
						name: "getSpreadsheet",
						description: "Get spreadsheet metadata",
						inputSchema: {
							type: "object",
							properties: {
								spreadsheetId: {
									type: "string",
									description: "Spreadsheet ID",
								},
							},
							required: ["spreadsheetId"],
						},
					},
					{
						name: "getValues",
						description: "Get cell values from a range",
						inputSchema: {
							type: "object",
							properties: {
								spreadsheetId: {
									type: "string",
									description: "Spreadsheet ID",
								},
								range: {
									type: "string",
									description: "A1 notation range",
								},
							},
							required: ["spreadsheetId", "range"],
						},
					},
					{
						name: "updateValues",
						description: "Update cell values in a range",
						inputSchema: {
							type: "object",
							properties: {
								spreadsheetId: {
									type: "string",
									description: "Spreadsheet ID",
								},
								range: {
									type: "string",
									description: "A1 notation range",
								},
								values: {
									type: "array",
									items: { type: "array", items: {} },
									description: "2D array of values",
								},
							},
							required: ["spreadsheetId", "range", "values"],
						},
					},
				],
				workflowGuidance: GOOGLE_SHEETS_WORKFLOW_GUIDANCE,
			},
		],
	},
	{
		id: "github",
		name: "GitHub",
		credentialType: "github_oauth",
		authType: "oauth",
		icon: "github",
		baseScopes: ["read:user", "user:email"],
		mcps: [
			{
				id: "github-repos",
				name: "GitHub",
				serverName: "GitHub",
				description:
					"Manage GitHub repositories, issues, and pull requests",
				icon: "git-branch",
				available: true,
				requiredScopes: ["repo", "read:org"],
				urlPatterns: [
					{
						pattern: "https://github.com/*/*",
						description: "GitHub repository pages",
					},
				],
				tools: [
					{
						name: "list_repositories",
						description:
							"List repositories for the authenticated user",
						inputSchema: {
							type: "object",
							properties: {
								type: {
									type: "string",
									enum: ["all", "owner", "member"],
									default: "all",
								},
								sort: {
									type: "string",
									enum: [
										"created",
										"updated",
										"pushed",
										"full_name",
									],
									default: "updated",
								},
								per_page: {
									type: "number",
									description: "Results per page (max 100)",
									default: 30,
								},
							},
						},
					},
					{
						name: "get_repository",
						description: "Get repository details",
						inputSchema: {
							type: "object",
							properties: {
								owner: {
									type: "string",
									description: "Repository owner",
								},
								repo: {
									type: "string",
									description: "Repository name",
								},
							},
							required: ["owner", "repo"],
						},
					},
					{
						name: "list_issues",
						description: "List issues for a repository",
						inputSchema: {
							type: "object",
							properties: {
								owner: {
									type: "string",
									description: "Repository owner",
								},
								repo: {
									type: "string",
									description: "Repository name",
								},
								state: {
									type: "string",
									enum: ["open", "closed", "all"],
									default: "open",
								},
								per_page: {
									type: "number",
									description: "Results per page (max 100)",
									default: 30,
								},
							},
							required: ["owner", "repo"],
						},
					},
					{
						name: "get_issue",
						description: "Get a specific issue by number",
						inputSchema: {
							type: "object",
							properties: {
								owner: {
									type: "string",
									description: "Repository owner",
								},
								repo: {
									type: "string",
									description: "Repository name",
								},
								issue_number: {
									type: "number",
									description: "Issue number",
								},
							},
							required: ["owner", "repo", "issue_number"],
						},
					},
					{
						name: "get_pull_request",
						description: "Get a specific pull request by number",
						inputSchema: {
							type: "object",
							properties: {
								owner: {
									type: "string",
									description: "Repository owner",
								},
								repo: {
									type: "string",
									description: "Repository name",
								},
								pull_number: {
									type: "number",
									description: "Pull request number",
								},
							},
							required: ["owner", "repo", "pull_number"],
						},
					},
					{
						name: "list_pull_requests",
						description: "List pull requests for a repository",
						inputSchema: {
							type: "object",
							properties: {
								owner: {
									type: "string",
									description: "Repository owner",
								},
								repo: {
									type: "string",
									description: "Repository name",
								},
								state: {
									type: "string",
									enum: ["open", "closed", "all"],
									default: "open",
								},
								head: {
									type: "string",
									description: "Filter by head branch",
								},
								base: {
									type: "string",
									description: "Filter by base branch",
								},
								per_page: {
									type: "number",
									description: "Results per page (max 100)",
									default: 30,
								},
							},
							required: ["owner", "repo"],
						},
					},
					{
						name: "create_pull_request",
						description: "Create a new pull request",
						inputSchema: {
							type: "object",
							properties: {
								owner: {
									type: "string",
									description: "Repository owner",
								},
								repo: {
									type: "string",
									description: "Repository name",
								},
								title: {
									type: "string",
									description: "PR title",
								},
								head: {
									type: "string",
									description: "Branch containing changes",
								},
								base: {
									type: "string",
									description:
										"Branch to merge into (usually main)",
								},
								body: {
									type: "string",
									description: "PR description",
								},
								draft: {
									type: "boolean",
									description: "Create as draft PR",
									default: false,
								},
							},
							required: [
								"owner",
								"repo",
								"title",
								"head",
								"base",
							],
						},
						approvalRequiredFields: ["title", "head", "base"],
					},
					{
						name: "create_issue",
						description: "Create a new issue",
						inputSchema: {
							type: "object",
							properties: {
								owner: {
									type: "string",
									description: "Repository owner",
								},
								repo: {
									type: "string",
									description: "Repository name",
								},
								title: {
									type: "string",
									description: "Issue title",
								},
								body: {
									type: "string",
									description: "Issue description",
								},
								labels: {
									type: "array",
									items: { type: "string" },
									description: "Labels to add",
								},
								assignees: {
									type: "array",
									items: { type: "string" },
									description: "Users to assign",
								},
							},
							required: ["owner", "repo", "title"],
						},
						approvalRequiredFields: ["title"],
					},
					{
						name: "get_file_contents",
						description: "Get contents of a file from a repository",
						inputSchema: {
							type: "object",
							properties: {
								owner: {
									type: "string",
									description: "Repository owner",
								},
								repo: {
									type: "string",
									description: "Repository name",
								},
								path: {
									type: "string",
									description: "File path",
								},
								ref: {
									type: "string",
									description:
										"Branch/tag/commit (default: main)",
								},
							},
							required: ["owner", "repo", "path"],
						},
					},
					{
						name: "list_branches",
						description: "List branches for a repository",
						inputSchema: {
							type: "object",
							properties: {
								owner: {
									type: "string",
									description: "Repository owner",
								},
								repo: {
									type: "string",
									description: "Repository name",
								},
								per_page: {
									type: "number",
									description: "Results per page (max 100)",
									default: 30,
								},
							},
							required: ["owner", "repo"],
						},
					},
				],
				workflowGuidance: GITHUB_WORKFLOW_GUIDANCE,
			},
		],
	},
	// Microsoft Teams - Conditionally enabled when user has connected Microsoft Graph OAuth
	{
		id: "microsoft_teams",
		name: "Microsoft Teams",
		credentialType: "microsoft_graph_oauth",
		authType: "oauth",
		icon: "message-square",
		baseScopes: ["openid", "email", "profile", "offline_access"],
		mcps: [
			{
				id: "microsoft-teams",
				name: "Microsoft Teams",
				serverName: "Microsoft_Teams",
				description:
					"Search and access Microsoft Teams messages, channels, and shared files",
				icon: "message-square",
				available: true,
				// Keep in step with oauthProviders.MICROSOFT_GRAPH.scopes — that
				// array is what actually lands in a token, this one only
				// describes the surface. A guard test compares the two.
				requiredScopes: [
					"User.Read",
					"User.ReadBasic.All",
					"Team.ReadBasic.All",
					"Channel.ReadBasic.All",
					"Chat.Read",
					"ChatMessage.Read",
					"ChannelMessage.Read.All",
					"ChannelMessage.Send",
					"ChatMessage.Send",
					"Files.Read.All",
					"OnlineMeetings.Read",
					// Read, not ReadWrite: no Teams tool writes a calendar. The
					// OAuth flow also requests ReadWrite, for the workflow
					// orchestrator's create-event action.
					"Calendars.Read",
					"OnlineMeetingTranscript.Read.All",
				],
				urlPatterns: [
					{
						pattern: "https://teams.microsoft.com/*",
						description: "Microsoft Teams web interface",
					},
				],
				tools: [
					{
						name: "list_teams",
						description: "List all Teams the user has joined",
						inputSchema: {
							type: "object",
							properties: {},
						},
					},
					{
						name: "list_channels",
						description: "List channels in a specific team",
						inputSchema: {
							type: "object",
							properties: {
								teamId: {
									type: "string",
									description: "Team ID to list channels for",
								},
							},
							required: ["teamId"],
						},
					},
					{
						name: "search_messages",
						description:
							"Search for messages across all Teams channels and chats",
						inputSchema: {
							type: "object",
							properties: {
								query: {
									type: "string",
									description: "Search query string",
								},
								limit: {
									type: "number",
									description:
										"Maximum number of results (default: 20)",
									default: 20,
								},
							},
							required: ["query"],
						},
					},
					{
						name: "list_messages",
						description:
							"List recent messages in a Team channel. IMPORTANT: Only use with Team IDs from list_teams — do NOT pass group chat IDs here. For group/direct chat messages, use get_chat_messages instead.",
						inputSchema: {
							type: "object",
							properties: {
								teamId: {
									type: "string",
									description:
										"Team ID (from list_teams). NOT a group chat ID — use get_chat_messages for group chats.",
								},
								channelId: {
									type: "string",
									description:
										"Channel ID (from list_channels)",
								},
								limit: {
									type: "number",
									description:
										"Maximum number of messages (default: 50)",
									default: 50,
								},
								since: {
									type: "string",
									description:
										"ISO 8601 datetime to filter messages after this date (e.g. 2026-02-13T00:00:00Z)",
								},
							},
							required: ["teamId", "channelId"],
						},
					},
					{
						name: "get_shared_files",
						description:
							"Get files shared in a Team channel's SharePoint folder. Requires Team ID from list_teams.",
						inputSchema: {
							type: "object",
							properties: {
								teamId: {
									type: "string",
									description: "Team ID (from list_teams)",
								},
								channelId: {
									type: "string",
									description:
										"Channel ID (from list_channels)",
								},
							},
							required: ["teamId", "channelId"],
						},
					},
					{
						name: "list_chats",
						description:
							"List the user's direct messages (1:1) and group chats. Use this to find chat IDs for get_chat_messages. These are NOT Team channels — for Team channels use list_teams + list_channels.",
						inputSchema: {
							type: "object",
							properties: {
								limit: {
									type: "number",
									description:
										"Maximum number of chats (default: 50)",
									default: 50,
								},
							},
						},
					},
					{
						name: "get_chat_messages",
						description:
							"Get messages from a direct (1:1) or group chat. Use chat IDs from list_chats. For Team channel messages, use list_messages instead.",
						inputSchema: {
							type: "object",
							properties: {
								chatId: {
									type: "string",
									description:
										"Chat ID (from list_chats). NOT a Team ID.",
								},
								limit: {
									type: "number",
									description:
										"Maximum number of messages (default: 50)",
									default: 50,
								},
							},
							required: ["chatId"],
						},
					},
				],
				workflowGuidance: MICROSOFT_TEAMS_WORKFLOW_GUIDANCE,
			},
		],
	},
];

// ============================================================================
// Registry Functions
// ============================================================================

/**
 * Get all registered accounts
 */
export function getAccounts(): AccountDefinition[] {
	return ACCOUNT_REGISTRY;
}

/**
 * Get account by ID
 */
export function getAccountById(
	accountId: string,
): AccountDefinition | undefined {
	return ACCOUNT_REGISTRY.find((a) => a.id === accountId);
}

/**
 * Get all MCPs for an account
 */
export function getAccountMcps(accountId: string): MCPDefinition[] {
	const account = getAccountById(accountId);
	return account?.mcps ?? [];
}

/**
 * Get available MCPs for an account (excluding coming soon)
 */
export function getAvailableAccountMcps(accountId: string): MCPDefinition[] {
	return getAccountMcps(accountId).filter(
		(mcp) => mcp.available !== false && !mcp.comingSoon,
	);
}

/**
 * Get specific MCP definition
 */
export function getMcpDefinition(
	accountId: string,
	mcpId: string,
): MCPDefinition | undefined {
	const mcps = getAccountMcps(accountId);
	return mcps.find((m) => m.id === mcpId);
}

/**
 * Get all required scopes for an account + specific MCPs
 */
export function getRequiredScopes(
	accountId: string,
	mcpIds?: string[],
): string[] {
	const account = getAccountById(accountId);
	if (!account) {
		return [];
	}

	const scopes = new Set<string>(account.baseScopes ?? []);

	const mcpsToInclude = mcpIds
		? account.mcps.filter((m) => mcpIds.includes(m.id))
		: account.mcps;

	for (const mcp of mcpsToInclude) {
		if (mcp.requiredScopes) {
			for (const scope of mcp.requiredScopes) {
				scopes.add(scope);
			}
		}
	}

	return Array.from(scopes);
}

/**
 * Get tools for a specific MCP
 */
export function getMcpTools(accountId: string, mcpId: string): MCPToolSchema[] {
	const mcp = getMcpDefinition(accountId, mcpId);
	return mcp?.tools ?? [];
}

/**
 * Find MCP by URL pattern match
 */
export function findMcpByUrl(url: string): {
	account: AccountDefinition;
	mcp: MCPDefinition;
	pattern: MCPUrlPattern;
} | null {
	for (const account of ACCOUNT_REGISTRY) {
		for (const mcp of account.mcps) {
			if (!mcp.urlPatterns) {
				continue;
			}

			for (const pattern of mcp.urlPatterns) {
				// Convert glob pattern to regex
				const regexPattern = pattern.pattern
					.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
					.replace(/\*/g, ".*");

				if (new RegExp(`^${regexPattern}$`).test(url)) {
					return { account, mcp, pattern };
				}
			}
		}
	}

	return null;
}

/**
 * Check if an account type is supported
 */
export function isAccountSupported(credentialType: string): boolean {
	return ACCOUNT_REGISTRY.some((a) => a.credentialType === credentialType);
}

/**
 * Get account by credential type
 */
export function getAccountByCredentialType(
	credentialType: string,
): AccountDefinition | undefined {
	return ACCOUNT_REGISTRY.find((a) => a.credentialType === credentialType);
}
