/**
 * Context passed to every Sidekick tool at creation time.
 * Contains the agent being edited, the current user, and optional conversation ID.
 *
 * `entityType` discriminates persistence behaviour:
 *  - "registered" — RegisteredAgent; tools persist suggestions as rows
 *  - "instance"   — AgentTemplateInstance; tools take the same pure
 *                   auto-apply path as NEW_AGENT_ID (no DB writes)
 *  - "new"        — unsaved agent; auto-apply only
 */
type SidekickEntityType = "registered" | "instance" | "new";

export interface SidekickToolContext {
	agentId: string;
	entityType: SidekickEntityType;
	userId: string;
	organizationId?: string;
	conversationId?: string;
}
