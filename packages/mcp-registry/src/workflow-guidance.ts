/**
 * Workflow Guidance Constants
 *
 * These provide detailed instructions to AI agents on how to use
 * specific MCP tools effectively. Injected into system prompts.
 */

export const SANDBOX_WORKFLOW_GUIDANCE = `## Code Change Workflow (Sandbox + GitHub)
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
   This returns a JSON object with:
   - \`diff\`: The complete unified diff string (ALL file changes)
   - \`stats\`: Object with { files, additions, deletions } counts

   **NOTE: The diff is automatically cached and will be injected into your PR approval request.**

5. **Request PR approval** - The diff is auto-injected from step 4:
   \`\`\`
   request_approval({
     tool: "GitHub__create_pull_request",
     action: "Create Pull Request",
     data: {
       owner, repo, baseBranch: "main", headBranch: "feature/your-branch-name",
       title, body
       // diff and stats are AUTO-INJECTED from the getDiff result
       // You do NOT need to include them - the workflow handles this automatically
     }
   })
   \`\`\`
   **NOTE: The workflow automatically injects the cached diff from getDiff to avoid truncation issues.**
   You only need to include: owner, repo, baseBranch, headBranch, title, and body.

6. **After user approval** - First check session, then commit, push, AND create PR:
   \`\`\`
   // IMPORTANT: Check if session is still valid (it may have expired during approval wait)
   Sandbox__getSession({ sessionId })  // Returns { valid: true/false }
   // If valid=false, recreate session, checkout same branch, and reapply changes
   Sandbox__commit({ sessionId, message: "..." })
   Sandbox__push({ sessionId, branch: "feature/your-branch-name" })
   GitHub__create_pr({ owner, repo, title, head: "feature/your-branch-name", base: "main", body })
   \`\`\`
   **CRITICAL: You MUST call GitHub__create_pr after pushing. The task is NOT complete until the PR is created.**
   **NOTE: Sandbox sessions may expire after ~15 minutes of inactivity. Always check with getSession after approval.**

7. **ALWAYS destroy the session** when done (success or failure):
   \`\`\`
   Sandbox__destroySession({ sessionId })
   \`\`\`

IMPORTANT RULES:
- createSession requires repoUrl parameter to clone the repo
- ALWAYS create a feature branch before making changes
- Do NOT call request_approval without first calling getDiff (the diff is cached automatically)
- The diff and stats are AUTO-INJECTED into PR approvals - you don't need to pass them explicitly
- Use the SAME branch name in: checkout, push, and create_pr
- After approval, you MUST: commit → push → create_pr (in that order)
- ALWAYS destroy the session when done`;

export const GMAIL_WORKFLOW_GUIDANCE = `## Gmail Workflow
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

export const GOOGLE_DOCS_WORKFLOW_GUIDANCE = `## Google Docs Workflow
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

export const GOOGLE_SHEETS_WORKFLOW_GUIDANCE = `## Google Sheets Workflow
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

export const GITHUB_WORKFLOW_GUIDANCE = `## GitHub Workflow
Use GitHub tools to read repository information, commits, issues, and pull requests.
For creating PRs with code changes, use Sandbox to make the changes first.

### Discovery: Finding owner and repo automatically

**When the user provides a commit SHA but not the repository:**
\`\`\`
GitHub__search_commits({ sha: "abc123def456..." })
\`\`\`
This returns the matching commit with \`owner\` and \`repo\` fields — use those in subsequent calls.
NEVER fill owner/repo with placeholders. Always discover real values first.

**When you need to know the current user's GitHub username:**
\`\`\`
GitHub__get_authenticated_user({})
\`\`\`
Returns \`{ login, name, ... }\` — the \`login\` is the owner for personal repositories.

**When you know the owner/repo and want to read a specific commit:**
\`\`\`
GitHub__get_commit({ owner: "real-owner", repo: "real-repo", ref: "abc123..." })
\`\`\`

### Reading repository info
\`\`\`
GitHub__list_repositories({})                                          // list the user's repos
GitHub__get_repository({ owner: "...", repo: "..." })                 // repo details
GitHub__list_issues({ owner: "...", repo: "...", state: "open" })
GitHub__get_pull_request({ owner: "...", repo: "...", pull_number: 123 })
\`\`\`

### Discovery workflow for commit-based tasks
1. Call \`GitHub__search_commits({ sha: "<commit-sha>" })\` → get real \`owner\` and \`repo\`
2. Call \`GitHub__get_commit({ owner, repo, ref: "<commit-sha>" })\` → returns:
   - \`message\`: commit message
   - \`stats\`: total additions/deletions
   - \`files[]\`: each file with \`filename\`, \`status\` (added/modified/removed), \`additions\`, \`deletions\`, and \`patch\` (the actual diff)
3. Use the \`files[].patch\` diffs to understand exactly what code changed — ALWAYS use these real values when creating diagrams, reports, or analyses.
4. Never create placeholder or example diagrams — always base diagrams on the actual file changes from the commit.`;

export const GITLAB_WORKFLOW_GUIDANCE = `## GitLab Workflow

You have access to GitLab via its official remote MCP server (Premium/Ultimate).
Tool names are advertised dynamically; call \`tools/list\` if you need the catalog.

Common patterns the GitLab MCP supports:
- Discover the authenticated user, their projects, issues, and merge requests.
- Read project metadata, file contents at a ref, and commit history.
- Create or update issues and merge requests when explicitly requested.

GitLab uses the term "merge request" (not "pull request") and \`iid\`
(project-scoped) vs \`id\` (global). Prefer \`iid\` when responding to a user
who has cited an issue/MR number from the GitLab UI.
`;

export const MICROSOFT_TEAMS_WORKFLOW_GUIDANCE = `## Microsoft Teams Workflow
Use Microsoft Teams tools to search and access Teams messages, channels, and shared files.
These tools query Microsoft Graph API in real-time using the user's connected Microsoft account.

### Navigation Tools

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

### Channel Messages

**Listing recent messages in a channel:**
\`\`\`
Microsoft_Teams__list_messages({ teamId: "team-id", channelId: "channel-id", limit: 50 })
\`\`\`
Returns recent messages from a specific channel. Use the 'since' parameter for date-based filtering:
\`\`\`
Microsoft_Teams__list_messages({ teamId: "...", channelId: "...", since: "2026-01-28T00:00:00Z", limit: 50 })
\`\`\`
This filters to messages from the last 2 weeks. The tool automatically paginates to find enough matching messages.

**Reading thread replies:**
\`\`\`
Microsoft_Teams__list_message_replies({ teamId: "team-id", channelId: "channel-id", messageId: "msg-id", limit: 25 })
\`\`\`
Channel conversations are threaded. Use this to read replies under a root message from list_messages.

### Search

**Searching messages across all Teams:**
\`\`\`
Microsoft_Teams__search_messages({ query: "project deadline", limit: 25 })
\`\`\`
Searches across all channels and chats. Supports KQL syntax:
- \`from:PersonName\` — messages from a specific person
- \`from:John about project\` — combined person + keyword
- Keywords — search message content

### Chats (Direct Messages & Group Chats)

**Listing recent chats:**
\`\`\`
Microsoft_Teams__list_chats({ chatType: "oneOnOne", limit: 15 })
\`\`\`
Returns recent chats with member names and last message preview. Filter by type: oneOnOne, group, or meeting.

**Reading chat messages:**
\`\`\`
Microsoft_Teams__get_chat_messages({ chatId: "chat-id", limit: 50 })
\`\`\`
Returns messages from a specific chat.

### Other Tools

**Getting full message content:**
\`\`\`
Microsoft_Teams__get_full_message({ messageId: "msg-id", chatId: "chat-id" })
\`\`\`
Retrieves the complete untruncated content of a message that was truncated in listings.

**Getting files shared in a channel:**
\`\`\`
Microsoft_Teams__get_shared_files({ teamId: "team-id", channelId: "channel-id" })
\`\`\`

**Searching for users:**
\`\`\`
Microsoft_Teams__list_users({ nameFilter: "John" })
\`\`\`
Note: May require admin consent. If permission denied, use search_messages with 'from:PersonName' instead.

### Meeting Transcripts

**Step 1: Find meetings with Teams links:**
\`\`\`
Microsoft_Teams__list_calendar_meetings({ startDate: "2026-01-01T00:00:00Z", endDate: "2026-02-01T00:00:00Z", limit: 25 })
\`\`\`
Returns calendar events that have online meeting (Teams) links. Look for the \`joinUrl\` in each result.

**Step 2: Resolve join URL to meeting ID:**
\`\`\`
Microsoft_Teams__get_meeting_by_join_url({ joinWebUrl: "https://teams.microsoft.com/l/meetup-join/..." })
\`\`\`
Takes the join URL from step 1 and returns the online meeting ID needed for transcript access.

**Step 3: List available transcripts:**
\`\`\`
Microsoft_Teams__list_meeting_transcripts({ meetingId: "meeting-id-from-step-2" })
\`\`\`
Returns transcript metadata including IDs and creation times.

**Step 4: Get transcript content:**
\`\`\`
Microsoft_Teams__get_meeting_transcript_content({ meetingId: "meeting-id", transcriptId: "transcript-id", format: "structured" })
\`\`\`
Returns the full transcript with speaker names, timestamps, and spoken text. Use format: "vtt" for raw WebVTT.

**Note:** there is no bulk transcript listing. Go meeting by meeting via the steps above.

Transcripts are only reachable for meetings the user organized that have a backing calendar event. A meeting someone else organized, or one started ad hoc from a chat, returns 403 no matter what permissions are held — \`OnlineMeetingTranscript.Read.All\` is granted, so a 403 is a reachability limit, not a consent problem. Do not tell the user to contact an administrator about it.

### Best Practices
- Always start by listing teams if you don't know the team ID
- Use search_messages for finding specific content across all Teams
- Use list_messages with 'since' for time-based channel summaries
- Use list_message_replies to read threaded discussions under channel messages
- For finding messages from a person, prefer search_messages with 'from:PersonName'
- For meeting transcripts, follow the 4-step flow: list_calendar_meetings → get_meeting_by_join_url → list_meeting_transcripts → get_meeting_transcript_content
- System event messages (member joins, renames) are automatically filtered out
- The user must have Microsoft connected in Settings for these tools to work`;

/**
 * Maps OAuth credential type to the workflow guidance strings for all MCPs
 * that use that credential. Used by the orchestrator to inject tool-specific
 * guidance into the system prompt when an integration is connected.
 *
 * Add new entries here whenever a new OAuth integration is added.
 */
export const CREDENTIAL_TYPE_GUIDANCE: Record<string, string[]> = {
	google_oauth: [
		GMAIL_WORKFLOW_GUIDANCE,
		GOOGLE_DOCS_WORKFLOW_GUIDANCE,
		GOOGLE_SHEETS_WORKFLOW_GUIDANCE,
	],
	github_oauth: [GITHUB_WORKFLOW_GUIDANCE],
	gitlab_oauth: [GITLAB_WORKFLOW_GUIDANCE],
	microsoft_graph_oauth: [MICROSOFT_TEAMS_WORKFLOW_GUIDANCE],
};

/**
 * Get workflow guidance for a given credential type.
 * Returns an empty string if no guidance is registered.
 */
export function getGuidanceByCredentialType(credentialType: string): string {
	const parts = CREDENTIAL_TYPE_GUIDANCE[credentialType];
	return parts ? parts.join("\n\n") : "";
}

/**
 * Maps MCPServer.name values to workflow guidance.
 * Used by the orchestrator to inject guidance when an account-based MCP
 * (Gmail, Google Docs, Google Sheets) is connected as an MCPConfig.
 *
 * Keys match the serverName field in MCPDefinition from the account registry.
 */
export const GUIDANCE_BY_SERVER_NAME: Record<string, string> = {
	Gmail: GMAIL_WORKFLOW_GUIDANCE,
	GoogleDocs: GOOGLE_DOCS_WORKFLOW_GUIDANCE,
	GoogleSheets: GOOGLE_SHEETS_WORKFLOW_GUIDANCE,
	GitHub: GITHUB_WORKFLOW_GUIDANCE,
	GitLab: GITLAB_WORKFLOW_GUIDANCE,
	Microsoft_Teams: MICROSOFT_TEAMS_WORKFLOW_GUIDANCE,
	Sandbox: SANDBOX_WORKFLOW_GUIDANCE,
};

/**
 * Get workflow guidance for a given MCP server name.
 * Matches against MCPServer.name in the database.
 * Returns an empty string if no guidance is registered for that name.
 */
export function getGuidanceByServerName(serverName: string): string {
	return GUIDANCE_BY_SERVER_NAME[serverName] ?? "";
}
