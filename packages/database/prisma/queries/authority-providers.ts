/**
 * Canonical Provider Key Map
 *
 * Single source of truth for mapping MCP server keys and integration
 * provider names to canonical provider keys. Used by:
 * - Gateway authority service
 * - Orchestrator authority gate
 * - MCP proxy authority check
 *
 * All enforcement points import from HERE to ensure consistent normalization.
 */

/**
 * Maps known MCP server keys and integration provider names to canonical keys.
 * Keys are lowercase. Add new providers here — all enforcement points will
 * pick them up automatically.
 */
export const CANONICAL_PROVIDER_KEYS: Record<string, string> = {
	// Development & Collaboration
	github: "github",
	"github-mcp": "github",
	linear: "linear",
	"linear-mcp": "linear",
	gitlab: "gitlab",
	bitbucket: "bitbucket",
	jira: "jira",
	"atlassian-jira": "jira",
	confluence: "confluence",
	"azure-devops": "azure-devops",
	figma: "figma",
	asana: "asana",
	trello: "trello",

	// Communication
	slack: "slack",
	"slack-mcp": "slack",
	"microsoft-teams": "microsoft-teams",
	"microsoft-graph": "microsoft-graph",
	discord: "discord",

	// Productivity
	notion: "notion",
	"notion-mcp": "notion",
	"google-drive": "google-drive",
	"google-docs": "google-docs",
	"google-sheets": "google-sheets",
	"google-calendar": "google-calendar",
	gmail: "gmail",

	// CRM & Sales
	hubspot: "hubspot",
	salesforce: "salesforce",
	intercom: "intercom",

	// Infrastructure & Monitoring
	datadog: "datadog",
	sentry: "sentry",
	pagerduty: "pagerduty",

	// Payments & Messaging
	stripe: "stripe",
	twilio: "twilio",
	sendgrid: "sendgrid",

	// Development tools
	excalidraw: "excalidraw",
	"excalidraw-mcp": "excalidraw",
};

/**
 * Resolve any key to a canonical provider key.
 * Returns `custom:{key}` for unknown providers.
 */
export function resolveCanonicalProviderKey(key: string): string {
	const normalized = key.toLowerCase().replace(/_/g, "-");
	return CANONICAL_PROVIDER_KEYS[normalized] ?? `custom:${normalized}`;
}
