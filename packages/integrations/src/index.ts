/**
 * @repo/integrations
 *
 * Shared integration utilities for external services (Microsoft, Slack, etc.).
 * Used by both API layer and Temporal activities.
 */

// Channel abstraction (Slice 5a) — uniform interface across Telegram, ...
// Side-effect import below also registers built-in adapters.
export * from "./channels/index";
// Databricks Vector Search
export * from "./databricks-vector-search/index";
// GitHub integrations
export * from "./github/index";
// Microsoft integrations (Teams, Outlook, etc.)
// Note: Internal utilities like truncateContent are not re-exported to avoid naming conflicts
export { executeMicrosoftTeamsTool } from "./microsoft/index";
// NHTSA vehicle data
export * from "./nhtsa/index";
// Self-healing repository auth — the canonical code-repo credential resolver
export * from "./repo-auth";
export * from "./repo-token-refresh-fault";
// Shared attachment types + constants (chat-thread image attachments feature)
export * from "./shared/attachment-constants";
export * from "./shared/attachment-types";

// Slack integrations
// Note: Internal utilities are not re-exported to avoid naming conflicts
export {
	cleanMentionText,
	DownloadFailedError,
	downloadSlackFile,
	ExternalWorkspaceError,
	executeSlackTool,
	getSlackCredentials,
	getSlackRetryInfo,
	normalizeThreadId,
	ScopeMissingError,
	sendSlackMessage,
	shouldProcessEvent,
	verifySlackSignature,
} from "./slack/index";
