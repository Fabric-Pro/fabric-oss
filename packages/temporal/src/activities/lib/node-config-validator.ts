/**
 * Node Configuration Validator
 *
 * Validates that required configuration fields are present before node execution.
 * Based on node-definitions from the workflow builder.
 */

interface ValidationResult {
	valid: boolean;
	error?: string;
	missingFields?: string[];
}

interface FieldRequirement {
	field: string;
	label: string;
}

/**
 * Required fields by node type
 */
const NODE_REQUIRED_FIELDS: Record<string, FieldRequirement[]> = {
	trigger: [],
	"ai-generate-text": [{ field: "aiPrompt", label: "Prompt" }],
	"ai-generate-image": [{ field: "imagePrompt", label: "Image Prompt" }],
	"http-request": [{ field: "url", label: "URL" }],
	"firecrawl-scrape": [{ field: "url", label: "URL" }],
	"firecrawl-search": [{ field: "query", label: "Search Query" }],
	condition: [{ field: "expression", label: "Expression" }],
	"linear-create-ticket": [{ field: "ticketTitle", label: "Ticket Title" }],
	"linear-find-issues": [{ field: "assignee", label: "Assignee" }],
	"email-send": [
		{ field: "to", label: "To" },
		{ field: "subject", label: "Subject" },
		{ field: "body", label: "Body" },
	],
	"slack-send": [
		{ field: "slackChannel", label: "Channel" },
		{ field: "slackMessage", label: "Message" },
	],
	"mcp-tool": [{ field: "toolName", label: "Tool Name" }],
	// GitHub nodes
	"github-create-issue": [
		{ field: "owner", label: "Repository Owner" },
		{ field: "repo", label: "Repository Name" },
		{ field: "issueTitle", label: "Issue Title" },
	],
	"github-search-issues": [{ field: "query", label: "Search Query" }],
	"github-get-file": [
		{ field: "owner", label: "Repository Owner" },
		{ field: "repo", label: "Repository Name" },
		{ field: "filePath", label: "File Path" },
	],
	"github-get-diff": [
		{ field: "owner", label: "Repository Owner" },
		{ field: "repo", label: "Repository Name" },
	],
	// Perplexity nodes
	"perplexity-search": [{ field: "query", label: "Query" }],
	// fal.ai nodes
	"fal-generate-image": [{ field: "prompt", label: "Prompt" }],
	"fal-generate-video": [{ field: "prompt", label: "Prompt" }],
};

/**
 * Validate node configuration before execution
 */
export function validateNodeConfig(
	nodeType: string,
	nodeConfig: Record<string, unknown>,
): ValidationResult {
	const requirements = NODE_REQUIRED_FIELDS[nodeType];

	// If no requirements defined, assume valid
	if (!requirements) {
		return { valid: true };
	}

	const missingFields: string[] = [];

	for (const req of requirements) {
		const value = nodeConfig[req.field];

		// Check if field is present and not empty
		if (value === undefined || value === null || value === "") {
			missingFields.push(req.label);
		}
	}

	if (missingFields.length > 0) {
		return {
			valid: false,
			error: `Missing required configuration: ${missingFields.join(", ")}`,
			missingFields,
		};
	}

	return { valid: true };
}

/**
 * Check if a node type is implemented
 */
export function isNodeTypeImplemented(nodeType: string): boolean {
	const IMPLEMENTED_NODES = [
		"trigger",
		"ai-generate-text",
		"ai-generate-image",
		"http-request",
		"firecrawl-scrape",
		"firecrawl-search",
		"condition",
		"linear-create-ticket",
		"linear-find-issues",
		"email-send",
		"slack-send",
		"mcp-tool",
		// GitHub nodes
		"github-create-issue",
		"github-search-issues",
		"github-get-file",
		"github-get-diff",
		// Perplexity nodes
		"perplexity-search",
		// fal.ai nodes
		"fal-generate-image",
		"fal-generate-video",
	];

	return IMPLEMENTED_NODES.includes(nodeType);
}

/**
 * Get a list of unimplemented node types (for logging/warning)
 */
export function getUnimplementedNodeTypes(): string[] {
	return []; // All node types are now implemented
}
