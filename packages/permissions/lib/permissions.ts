/**
 * Permission keys. Each key represents a single action on a resource.
 * Naming: `<domain>:<resource>:<action>` or `<domain>:<action>`.
 * Extend this list when adding new procedures — the role matrix in roles.ts
 * must also be updated for the permission to be granted to any role.
 */
export const Permissions = {
	// Organization
	ORG_READ: "org:read",
	ORG_UPDATE: "org:update",
	ORG_DELETE: "org:delete",
	ORG_MEMBERS_READ: "org:members:read",
	ORG_MEMBERS_INVITE: "org:members:invite",
	ORG_MEMBERS_REMOVE: "org:members:remove",
	ORG_MEMBERS_UPDATE_ROLE: "org:members:update_role",
	ORG_SETTINGS_READ: "org:settings:read",
	ORG_SETTINGS_EDIT: "org:settings:edit",
	ORG_BILLING_READ: "org:billing:read",
	ORG_BILLING_MANAGE: "org:billing:manage",
	ORG_API_KEYS_READ: "org:api_keys:read",
	ORG_API_KEYS_CREATE: "org:api_keys:create",
	ORG_API_KEYS_DELETE: "org:api_keys:delete",
	ORG_AUDIT_LOG_READ: "org:audit_log:read",
	ORG_AUDIT_LOG_EXPORT: "org:audit_log:export",
	ORG_INTEGRATIONS_READ: "org:integrations:read",
	ORG_INTEGRATIONS_MANAGE: "org:integrations:manage",
	ORG_AI_CONFIG_READ: "org:ai_config:read",
	ORG_AI_CONFIG_EDIT: "org:ai_config:edit",
	ORG_RAG_SETTINGS_READ: "org:rag_settings:read",
	ORG_RAG_SETTINGS_EDIT: "org:rag_settings:edit",
	ORG_OPENAPI_READ: "org:openapi:read",
	ORG_OPENAPI_MANAGE: "org:openapi:manage",
	ORG_DATA_CONNECTIONS_READ: "org:data_connections:read",
	ORG_DATA_CONNECTIONS_MANAGE: "org:data_connections:manage",

	// Project
	PROJECT_READ: "project:read",
	PROJECT_CREATE: "project:create",
	PROJECT_UPDATE: "project:update",
	PROJECT_DELETE: "project:delete",
	PROJECT_TRANSFER: "project:transfer",
	PROJECT_SETTINGS_READ: "project:settings:read",
	PROJECT_SETTINGS_EDIT: "project:settings:edit",
	PROJECT_MEMBERS_READ: "project:members:read",
	PROJECT_MEMBERS_MANAGE: "project:members:manage",

	// Stories / Features
	STORY_READ: "story:read",
	STORY_CREATE: "story:create",
	STORY_UPDATE: "story:update",
	STORY_DELETE: "story:delete",
	STORY_MOVE: "story:move",
	STORY_TASK_MANAGE: "story:task:manage",

	// Documents
	DOCUMENT_READ: "document:read",
	DOCUMENT_CREATE: "document:create",
	DOCUMENT_UPDATE: "document:update",
	DOCUMENT_DELETE: "document:delete",
	DOCUMENT_LOCK: "document:lock",

	// Architecture Decision Log (ADL)
	ARCHITECTURE_DECISION_READ: "architecture_decision:read",
	ARCHITECTURE_DECISION_CREATE: "architecture_decision:create",
	ARCHITECTURE_DECISION_UPDATE: "architecture_decision:update",
	ARCHITECTURE_DECISION_DELETE: "architecture_decision:delete",

	// Test Cases
	TEST_CASE_READ: "test-case:read",
	TEST_CASE_CREATE: "test-case:create",
	TEST_CASE_UPDATE: "test-case:update",
	TEST_CASE_DELETE: "test-case:delete",

	// Publishing Suite
	PUBLISHING_TOPIC_READ: "publishing-topic:read",
	PUBLISHING_TOPIC_CREATE: "publishing-topic:create",
	PUBLISHING_TOPIC_UPDATE: "publishing-topic:update",
	PUBLISHING_TOPIC_DELETE: "publishing-topic:delete",

	// Comments
	COMMENT_READ: "comment:read",
	COMMENT_CREATE: "comment:create",
	COMMENT_UPDATE: "comment:update",
	COMMENT_DELETE: "comment:delete",

	// Project contexts
	CONTEXT_READ: "context:read",
	CONTEXT_CREATE: "context:create",
	CONTEXT_UPDATE: "context:update",
	CONTEXT_DELETE: "context:delete",

	// Diagrams (Excalidraw / visual workspace)
	DIAGRAM_READ: "diagram:read",
	DIAGRAM_CREATE: "diagram:create",
	DIAGRAM_UPDATE: "diagram:update",
	DIAGRAM_DELETE: "diagram:delete",

	// Agents
	AGENT_READ: "agent:read",
	AGENT_CREATE: "agent:create",
	AGENT_UPDATE: "agent:update",
	AGENT_DELETE: "agent:delete",
	AGENT_EXECUTE: "agent:execute",
	AGENT_TEMPLATE_READ: "agent:template:read",
	AGENT_TEMPLATE_MANAGE: "agent:template:manage",

	// AI
	AI_CHAT: "ai:chat",
	AI_MODEL_RESOLVE: "ai:model:resolve",
	AI_MEMORY_READ: "ai:memory:read",
	AI_MEMORY_MANAGE: "ai:memory:manage",

	// MCP
	MCP_READ: "mcp:read",
	MCP_CREATE: "mcp:create",
	MCP_UPDATE: "mcp:update",
	MCP_DELETE: "mcp:delete",
	MCP_CONNECT: "mcp:connect",

	// Prompts
	PROMPT_READ: "prompt:read",
	PROMPT_CREATE: "prompt:create",
	PROMPT_UPDATE: "prompt:update",
	PROMPT_DELETE: "prompt:delete",

	// Reports
	REPORT_READ: "report:read",
	REPORT_CREATE: "report:create",
	REPORT_UPDATE: "report:update",
	REPORT_DELETE: "report:delete",
	REPORT_EXECUTE: "report:execute",
	REPORT_SHARE: "report:share",
	REPORT_TEMPLATE_READ: "report:template:read",
	REPORT_TEMPLATE_MANAGE: "report:template:manage",

	// Skills
	SKILL_READ: "skill:read",
	SKILL_CREATE: "skill:create",
	SKILL_UPDATE: "skill:update",
	SKILL_DELETE: "skill:delete",

	// Integrations (GitHub, GitLab, etc. at project or org scope)
	INTEGRATION_READ: "integration:read",
	INTEGRATION_CONNECT: "integration:connect",
	INTEGRATION_DISCONNECT: "integration:disconnect",
	INTEGRATION_USE: "integration:use",

	// Workspaces
	WORKSPACE_READ: "workspace:read",
	WORKSPACE_CREATE: "workspace:create",
	WORKSPACE_UPDATE: "workspace:update",
	WORKSPACE_DELETE: "workspace:delete",

	// Dashboard
	DASHBOARD_READ: "dashboard:read",

	// User (self)
	USER_READ_SELF: "user:read_self",
	USER_UPDATE_SELF: "user:update_self",

	// Notifications (per-recipient inbox; WRITE is server-only)
	NOTIFICATIONS_READ: "notifications:read",
	NOTIFICATIONS_WRITE: "notifications:write",
} as const;

export type Permission = (typeof Permissions)[keyof typeof Permissions];

export const ALL_PERMISSIONS: readonly Permission[] = Object.freeze(
	Object.values(Permissions),
);
