/**
 * Node Field Mappings
 *
 * SINGLE SOURCE OF TRUTH for all node field names.
 *
 * This file defines all valid field names for each node type.
 * Both the workflow builder UI and the validation logic should
 * reference these mappings to ensure consistency.
 *
 * When adding a new node type or field:
 * 1. Add it here first
 * 2. Update the workflow builder node definition
 * 3. Update the step implementation
 * 4. The validation will automatically pick it up
 */

export interface FieldMapping {
	/** Primary field name used by the workflow builder UI */
	primary: string;
	/** Alternative field names (SDK format, legacy, etc.) */
	aliases: string[];
	/** Human-readable label for error messages */
	label: string;
	/** Whether this field is required */
	required: boolean;
}

export interface NodeFieldDefinition {
	/** Node type identifier */
	nodeType: string;
	/** Human-readable name */
	displayName: string;
	/** Required fields for this node type */
	requiredFields: FieldMapping[];
	/** Optional fields with validation */
	optionalFields?: FieldMapping[];
}

/**
 * Field definitions for all workflow node types
 */
export const NODE_FIELD_DEFINITIONS: NodeFieldDefinition[] = [
	{
		nodeType: "trigger",
		displayName: "Trigger",
		requiredFields: [],
	},
	{
		nodeType: "ai-generate-text",
		displayName: "Generate Text",
		requiredFields: [
			{
				primary: "aiPrompt",
				aliases: ["prompt", "systemPrompt"],
				label: "Prompt",
				required: true,
			},
		],
		optionalFields: [
			{
				primary: "aiModel",
				aliases: ["model"],
				label: "AI Model",
				required: false,
			},
			{
				primary: "temperature",
				aliases: [],
				label: "Temperature",
				required: false,
			},
			{
				primary: "aiFormat",
				aliases: ["format", "outputFormat"],
				label: "Output Format",
				required: false,
			},
		],
	},
	{
		nodeType: "ai-generate-image",
		displayName: "Generate Image",
		requiredFields: [
			{
				primary: "imagePrompt",
				aliases: ["prompt"],
				label: "Image Prompt",
				required: true,
			},
		],
		optionalFields: [
			{
				primary: "imageModel",
				aliases: ["model"],
				label: "Image Model",
				required: false,
			},
		],
	},
	{
		nodeType: "http-request",
		displayName: "HTTP Request",
		requiredFields: [
			{
				primary: "url",
				aliases: [],
				label: "URL",
				required: true,
			},
		],
		optionalFields: [
			{
				primary: "method",
				aliases: [],
				label: "HTTP Method",
				required: false,
			},
			{
				primary: "headers",
				aliases: [],
				label: "Headers",
				required: false,
			},
			{
				primary: "body",
				aliases: ["data", "payload"],
				label: "Request Body",
				required: false,
			},
		],
	},
	{
		nodeType: "slack-send",
		displayName: "Send Slack Message",
		requiredFields: [
			{
				primary: "slackChannel",
				aliases: ["channel", "channelId"],
				label: "Channel",
				required: true,
			},
			{
				primary: "slackMessage",
				aliases: ["message", "text"],
				label: "Message",
				required: true,
			},
		],
	},
	{
		nodeType: "email-send",
		displayName: "Send Email",
		requiredFields: [
			{
				primary: "to",
				aliases: ["recipient", "email"],
				label: "To",
				required: true,
			},
			{
				primary: "subject",
				aliases: [],
				label: "Subject",
				required: true,
			},
			{
				primary: "body",
				aliases: ["content", "html"],
				label: "Body",
				required: true,
			},
		],
	},
	{
		nodeType: "linear-create-ticket",
		displayName: "Create Linear Ticket",
		requiredFields: [
			{
				primary: "ticketTitle",
				aliases: ["title"],
				label: "Ticket Title",
				required: true,
			},
		],
		optionalFields: [
			{
				primary: "ticketDescription",
				aliases: ["description"],
				label: "Description",
				required: false,
			},
			{
				primary: "teamId",
				aliases: [],
				label: "Team ID",
				required: false,
			},
		],
	},
	{
		nodeType: "linear-find-issues",
		displayName: "Find Linear Issues",
		requiredFields: [
			{
				primary: "assignee",
				aliases: [],
				label: "Assignee",
				required: true,
			},
		],
	},
	{
		nodeType: "browser-automation",
		displayName: "Browser Automation",
		requiredFields: [
			{
				primary: "url",
				aliases: ["startUrl"],
				label: "Starting URL",
				required: true,
			},
			{
				primary: "actions",
				aliases: ["steps"],
				label: "Browser Actions",
				required: true,
			},
		],
	},
	{
		nodeType: "firecrawl-scrape",
		displayName: "Scrape URL",
		requiredFields: [
			{
				primary: "url",
				aliases: [],
				label: "URL",
				required: true,
			},
		],
	},
	{
		nodeType: "firecrawl-search",
		displayName: "Web Search",
		requiredFields: [
			{
				primary: "query",
				aliases: ["searchQuery"],
				label: "Search Query",
				required: true,
			},
		],
	},
	{
		nodeType: "mcp-tool",
		displayName: "MCP Tool",
		requiredFields: [
			{
				primary: "toolName",
				aliases: ["tool"],
				label: "Tool Name",
				required: true,
			},
		],
	},
	{
		nodeType: "github-create-issue",
		displayName: "Create GitHub Issue",
		requiredFields: [
			{
				primary: "owner",
				aliases: [],
				label: "Repository Owner",
				required: true,
			},
			{
				primary: "repo",
				aliases: ["repository"],
				label: "Repository Name",
				required: true,
			},
			{
				primary: "issueTitle",
				aliases: ["title"],
				label: "Issue Title",
				required: true,
			},
		],
	},
	{
		nodeType: "github-search-issues",
		displayName: "Search GitHub Issues",
		requiredFields: [
			{
				primary: "query",
				aliases: ["searchQuery"],
				label: "Search Query",
				required: true,
			},
		],
	},
	{
		nodeType: "github-get-file",
		displayName: "Get GitHub File",
		requiredFields: [
			{
				primary: "owner",
				aliases: [],
				label: "Repository Owner",
				required: true,
			},
			{
				primary: "repo",
				aliases: ["repository"],
				label: "Repository Name",
				required: true,
			},
			{
				primary: "filePath",
				aliases: ["path"],
				label: "File Path",
				required: true,
			},
		],
	},
	{
		nodeType: "github-get-diff",
		displayName: "Get GitHub Diff",
		requiredFields: [
			{
				primary: "owner",
				aliases: [],
				label: "Repository Owner",
				required: true,
			},
			{
				primary: "repo",
				aliases: ["repository"],
				label: "Repository Name",
				required: true,
			},
		],
	},
	{
		nodeType: "perplexity-search",
		displayName: "Perplexity Search",
		requiredFields: [
			{
				primary: "query",
				aliases: ["searchQuery"],
				label: "Query",
				required: true,
			},
		],
	},
	{
		nodeType: "fal-generate-image",
		displayName: "FAL Generate Image",
		requiredFields: [
			{
				primary: "prompt",
				aliases: ["imagePrompt"],
				label: "Prompt",
				required: true,
			},
		],
	},
	{
		nodeType: "fal-generate-video",
		displayName: "FAL Generate Video",
		requiredFields: [
			{
				primary: "prompt",
				aliases: ["videoPrompt"],
				label: "Prompt",
				required: true,
			},
		],
	},
];

/**
 * Get field definition for a node type
 */
export function getNodeFieldDefinition(
	nodeType: string,
): NodeFieldDefinition | undefined {
	return NODE_FIELD_DEFINITIONS.find((def) => def.nodeType === nodeType);
}

/**
 * Check if a field has a valid value in the config
 * Checks both primary field name and all aliases
 */
export function hasValidFieldValue(
	config: Record<string, unknown>,
	field: FieldMapping,
): boolean {
	// Check primary field
	const primaryValue = config[field.primary];
	if (isValidValue(primaryValue)) {
		return true;
	}

	// Check aliases
	for (const alias of field.aliases) {
		const aliasValue = config[alias];
		if (isValidValue(aliasValue)) {
			return true;
		}
	}

	return false;
}

/**
 * Check if a value is valid (non-empty string, non-null, etc.)
 */
function isValidValue(value: unknown): boolean {
	if (value === undefined || value === null) {
		return false;
	}

	if (typeof value === "string") {
		return value.trim().length > 0;
	}

	if (Array.isArray(value)) {
		return value.length > 0;
	}

	return true;
}

/**
 * Validate a node config against its field definitions
 * Returns list of missing required fields
 */
export function validateNodeFields(
	nodeType: string,
	config: Record<string, unknown>,
): { valid: boolean; missingFields: string[] } {
	const definition = getNodeFieldDefinition(nodeType);

	if (!definition) {
		// Unknown node type - allow to pass (no validation rules)
		return { valid: true, missingFields: [] };
	}

	const missingFields: string[] = [];

	for (const field of definition.requiredFields) {
		if (!hasValidFieldValue(config, field)) {
			missingFields.push(field.label);
		}
	}

	return {
		valid: missingFields.length === 0,
		missingFields,
	};
}
