/**
 * Sidekick suggestion limits.
 * Enforced server-side when creating suggestions.
 * Mirrored in the Sidekick system prompt so the LLM knows about them.
 */
export const MAX_PENDING_INSTRUCTIONS = 10;
export const MAX_PENDING_TOOLS = 3;
export const MAX_PENDING_SKILLS = 3;
export const MAX_PENDING_KNOWLEDGE = 3;
export const MAX_PENDING_SUB_AGENT = 2;
export const MAX_PENDING_MODEL = 1;

/** Sentinel agent ID used for agents that haven't been persisted yet. */
export const NEW_AGENT_ID = "new";

/** Sentinel block ID for the instructions root wrapper node. */
export const INSTRUCTIONS_ROOT_BLOCK_ID = "instructions-root";

/**
 * Canonical list of knowledge-source integration type IDs.
 * Used in the system prompt, tool auto-detection, and frontend auto-apply.
 */
export const KNOWLEDGE_INTEGRATION_TYPES = [
	"NOTION",
	"GOOGLE_DRIVE",
	"CONFLUENCE",
	"MICROSOFT_GRAPH",
	"SLACK",
	"GITHUB",
	"JIRA",
	"LINEAR",
] as const;

/**
 * Maps human-readable keywords to integration type IDs.
 * Used by suggest_prompt_edits to auto-detect knowledge sources from content.
 */
export const KNOWLEDGE_KEYWORD_MAP: Record<string, string> = {
	notion: "NOTION",
	"google drive": "GOOGLE_DRIVE",
	confluence: "CONFLUENCE",
	"microsoft teams": "MICROSOFT_GRAPH",
	sharepoint: "MICROSOFT_GRAPH",
	slack: "SLACK",
	github: "GITHUB",
	jira: "JIRA",
	linear: "LINEAR",
};
