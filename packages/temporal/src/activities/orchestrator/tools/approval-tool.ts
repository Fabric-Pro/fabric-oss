/**
 * Request Approval Tool
 *
 * Built-in tool for requesting user approval before irreversible actions.
 * Inspired by Weft's request_approval pattern.
 *
 * This tool pauses workflow execution and waits for user approval with
 * rich preview data for different operation types (PR, email, doc, etc.).
 */

/**
 * Tool definition for request_approval
 */
export const requestApprovalToolDefinition = {
	name: "request_approval",
	description: `Pause execution and ask user for approval before proceeding with an action.
Use this BEFORE calling any tool that:
- Sends emails or messages
- Creates or modifies documents or spreadsheets
- Makes commits or creates pull requests
- Modifies external systems in any way

The user will see a rich preview of the action and can approve, reject, or request changes.
If the user edits the data during approval, the modified data will be returned.

CRITICAL: Always include relevant preview data:
- For PRs: Include diff, stats, title, body
- For emails: Include to, subject, body
- For docs: Include title, content (and currentContent for modifications)
- For sheets: Include title, rows (and currentRows for modifications)`,
	parameters: {
		type: "object" as const,
		properties: {
			tool: {
				type: "string" as const,
				description:
					"The MCP tool that will be called if approved (e.g., 'GitHub__create_pr', 'Gmail__sendEmail')",
			},
			action: {
				type: "string" as const,
				description:
					"Short human-readable action label (e.g., 'Create Pull Request', 'Send Email')",
			},
			data: {
				type: "object" as const,
				description: `The data to be approved. Include all relevant preview information:
- For GitHub PRs: { owner, repo, baseBranch, headBranch, title, body, diff, stats }
- For emails: { to, subject, body, cc?, bcc? }
- For docs: { title, content, documentId?, currentContent?, action: 'create'|'append'|'replace' }
- For sheets: { title?, spreadsheetId?, rows, currentRows?, newRows? }`,
			},
		},
		required: ["tool", "action", "data"],
	},
};

/**
 * Input type for request_approval tool
 */
export interface RequestApprovalInput {
	/** The MCP tool that will be called if approved */
	tool: string;
	/** Human-readable action label */
	action: string;
	/** Data to be approved (tool-specific structure) */
	data: Record<string, unknown>;
}

/**
 * Output type for request_approval tool
 */
export interface RequestApprovalOutput {
	/** Whether the approval was granted */
	approved: boolean;
	/** User feedback if changes were requested */
	feedback?: string;
	/** User-edited data (if user modified the approval data) */
	userData?: Record<string, unknown>;
}

/**
 * Get the request_approval tool definition.
 * This should be added to the orchestrator's tool list.
 */
export function getApprovalToolDefinition() {
	return requestApprovalToolDefinition;
}

/**
 * System prompt addition for approval handling
 */
export const APPROVAL_SYSTEM_PROMPT = `
## Approval Guidelines

Always request approval before:
- Sending emails or messages
- Creating or modifying documents or spreadsheets
- Making commits or pushing code
- Creating pull requests
- Any action that modifies external systems

When requesting approval, you MUST include:
- Clear description of what you want to do
- Complete preview data for the UI to display
- Any context the user needs to make a decision

CRITICAL: Handling user edits in approval responses
When the approval result contains a 'userData' field, the user has edited the data during approval.
You MUST use the values from 'userData' to override your original data when calling the actual tool.
This applies to ALL approval types - emails, documents, PRs, etc.

Example flow:
1. Call request_approval with full preview data
2. If approved with userData, merge userData with original data
3. Call the actual tool with the merged data
4. If rejected or feedback provided, iterate based on feedback

Example for PR approval:
\`\`\`
// 1. Get diff first
const diff = await Sandbox__getDiff({ sessionId });

// 2. Request approval with complete data
const approval = await request_approval({
  tool: "GitHub__create_pr",
  action: "Create Pull Request",
  data: {
    owner: "...",
    repo: "...",
    baseBranch: "main",
    headBranch: "feature/...",
    title: "PR Title",
    body: "Description...",
    diff: diff.diff,
    stats: diff.stats
  }
});

// 3. Handle result
if (approval.approved) {
  // Use userData if provided (user may have edited title/body)
  const finalData = approval.userData || approval.data;
  await GitHub__create_pr({ ...finalData });
} else if (approval.feedback) {
  // Iterate based on feedback
}
\`\`\`
`;
