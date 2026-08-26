/**
 * Plugin Types for Workflow Integrations
 * Aligned with Vercel workflow-builder-template patterns
 * See: https://github.com/vercel-labs/workflow-builder-template/blob/main/CONTRIBUTING.md
 */

import type { ComponentType } from "react";

/**
 * Integration provider types matching database enum
 */
export type IntegrationType =
	| "AI_GATEWAY"
	| "ASANA"
	| "ATTIO"
	| "BITBUCKET"
	| "BLOB"
	| "CANVA"
	| "CLERK"
	| "CLICKUP"
	| "CONFLUENCE"
	| "CUSTOM_WEBHOOK"
	| "DATABASE"
	| "DATABRICKS_VECTOR_SEARCH"
	| "FAL"
	| "FIRECRAWL"
	| "FRESHSERVICE"
	| "FRONT"
	| "GMAIL"
	| "GITHUB"
	| "GITLAB"
	| "GOOGLE_DRIVE"
	| "HUBSPOT"
	| "INTERCOM"
	| "JIRA"
	| "LINEAR"
	| "MCP"
	| "MICROSOFT_GRAPH"
	| "NHTSA_VPIC"
	| "NOTION"
	| "PERPLEXITY"
	| "RESEND"
	| "SALESFORCE"
	| "SLACK"
	| "STRIPE"
	| "SUPERAGENT"
	| "TELEGRAM"
	| "WEBFLOW"
	| "ZENDESK";

/**
 * Form field definition for plugin settings (API keys, etc.)
 * Matches Vercel template formFields structure
 */
export interface IntegrationFormField {
	id: string;
	label: string;
	type: "text" | "password" | "url" | "email" | "number";
	placeholder?: string;
	helpText?: string;
	helpLink?: { text: string; url: string };
	configKey: string;
	envVar?: string; // Maps to environment variable for credential mapping
	required?: boolean;
}

/**
 * Output field for template autocomplete
 * Defines what fields the action returns
 */
interface OutputField {
	field: string;
	description: string;
}

/**
 * Output display configuration
 */
type OutputDisplayConfig =
	| {
			type: "image" | "video" | "url" | "json";
			field: string;
	  }
	| {
			type: "component";
			component: ComponentType<{ output: unknown; input?: unknown }>;
	  };

/**
 * Config field for an action (declarative UI definition)
 * Uses 'key' to match Vercel template pattern
 */
export interface ActionConfigField {
	/** Field key (matches Vercel template's 'key') */
	key: string;
	/** Display label */
	label: string;
	/** Field type */
	type:
		| "text"
		| "textarea"
		| "number"
		| "select"
		| "boolean"
		| "template-input"
		| "template-textarea"
		| "ai-model-selector"
		| "schema-builder"
		| "mcp-selector"
		| "mcp-tool-selector"
		| "group";
	required?: boolean;
	placeholder?: string;
	description?: string;
	options?: { value: string; label: string }[];
	defaultValue?: string;
	example?: string;
	rows?: number;
	min?: number;
	/** Conditional display */
	showWhen?: {
		field: string;
		equals: string;
	};
	/** For 'group' type: nested fields */
	fields?: ActionConfigField[];
	defaultExpanded?: boolean;
}

/**
 * Action definition for a plugin
 * Aligned with Vercel template action structure
 */
export interface IntegrationAction {
	/** Action identifier (e.g., "send-message") - matches Vercel 'slug' */
	slug: string;
	/**
	 * The node type this action is stored as in `Workflow.nodes`, and the key
	 * the executor is registered under.
	 *
	 * Defaults to `<integration-type>-<slug>`, which is right for most actions.
	 * Set it explicitly ONLY where the stored name already differs — five do,
	 * for historical reasons:
	 *
	 *   AI_GATEWAY/generate-text  -> ai-generate-text
	 *   AI_GATEWAY/generate-image -> ai-generate-image
	 *   MCP/execute-tool          -> mcp-tool
	 *   RESEND/send-email         -> email-send
	 *   SLACK/send-message        -> slack-send
	 *
	 * This field exists so nothing ever derives those names. Changing a node
	 * type renames it in every saved workflow, and these five are the most-used
	 * nodes in the product.
	 */
	nodeType?: string;
	/** Display label */
	label: string;
	/** Description of what this action does */
	description: string;
	/** Category for grouping in UI */
	category: string;
	/** Declarative config fields (not React components) */
	configFields: ActionConfigField[];
	/** Output fields for template autocomplete */
	outputFields?: OutputField[];
	/** Output display configuration */
	outputConfig?: OutputDisplayConfig;
	/** Step function name for server execution */
	stepFunction?: string;
	/** Import path for step function (relative to steps/) */
	stepImportPath?: string;
}

/**
 * Settings component props for custom integration settings UI
 */
export interface IntegrationSettingsProps {
	apiKey: string;
	hasKey?: boolean;
	onApiKeyChange: (value: string) => void;
	config?: Record<string, unknown>;
	onConfigChange?: (config: Record<string, unknown>) => void;
	/** Organization ID - pass null for personal context, string for org context */
	organizationId?: string | null;
}

/**
 * Test connection result
 */
export interface TestConnectionResult {
	success: boolean;
	message?: string;
	error?: string;
}

/**
 * Integration category for UI organization
 * - "knowledge": Data sources for reading/searching (Notion, GitHub, Google Drive)
 * - "tool": Action-oriented integrations (Linear, Resend, FAL)
 * - "both": Can be used as both knowledge source and tool (Slack, GitHub)
 */
type IntegrationCategory = "knowledge" | "tool" | "both";

/**
 * Complete integration plugin definition
 * Aligned with Vercel workflow-builder-template patterns
 */
export interface IntegrationPlugin {
	/** Unique integration type identifier */
	type: IntegrationType;
	/** Category for UI organization (knowledge sources vs tools) */
	category: IntegrationCategory;
	/** Display label */
	label: string;
	/** Description of the integration */
	description: string;
	/** Icon component (Lucide icon or custom SVG component) */
	icon: ComponentType<{ className?: string }>;
	/** Optional color class for styling */
	color?: string;
	/** Optional brand hex color for icon backgrounds */
	brandColor?: string;

	/** Form fields for integration settings (API keys, etc.) */
	formFields: IntegrationFormField[];

	/** Optional custom settings component (uppercase for OAuth integrations) */
	SettingsComponent?: ComponentType<IntegrationSettingsProps>;
	/** Optional custom settings component (lowercase for backward compatibility) */
	settingsComponent?: ComponentType<IntegrationSettingsProps>;

	/** Lazy-loaded test function (preferred - avoids bundling server code) */
	testConfig?: {
		/** Get test function to validate credentials */
		getTestFunction?: () => Promise<
			(
				credentials: Record<string, string>,
			) => Promise<TestConnectionResult>
		>;
		/** Skip client-side test (for OAuth integrations that check status via API) */
		skipClientTest?: boolean;
	};

	/** Direct test function (deprecated - use testConfig for lazy loading) */
	testConnection?: (
		credentials: Record<string, string>,
	) => Promise<TestConnectionResult>;

	/** Actions provided by this integration */
	actions: IntegrationAction[];
}

/**
 * Action with integration context (used in registry lookups)
 */
export type ActionWithContext = IntegrationAction & {
	integrationType: IntegrationType;
	integrationLabel: string;
	/** Full action ID: "integration-type/action-slug" */
	actionId: string;
	/** Node type for workflow builder compatibility */
	nodeType: string;
};
