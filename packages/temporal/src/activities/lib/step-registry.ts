/**
 * Step Registry
 *
 * Maps node types to executable step functions.
 * Follows the Vercel workflow-builder-template pattern for scalability.
 *
 * @see https://github.com/vercel-labs/workflow-builder-template/blob/main/lib/steps/index.ts
 *
 * Benefits of this pattern:
 * 1. Lazy loading - steps are imported only when needed
 * 2. Easy to add new steps - just add an entry to the registry
 * 3. Clear separation of concerns - each step is in its own file
 * 4. Type-safe - step functions have typed inputs and outputs
 * 5. Testable - individual steps can be unit tested
 */

import {
	EXTERNAL_WRITE_NODE_TYPES,
	isExternalWriteNodeType,
	isNonRetryableNodeType,
	LEGACY_NODE_TYPE_ALIASES,
	resolveNodeType,
} from "../../workflows/lib/workflow-builder-nodes";
import type { NodeExecutionResult, StepParams } from "../types";

/**
 * Step function type - all step functions must conform to this signature
 */
export type StepFunction = (params: StepParams) => Promise<NodeExecutionResult>;

/**
 * Step registry entry with lazy loading support
 */
interface StepRegistryEntry {
	/** Human-readable name for logging */
	name: string;
	/** Import the step function lazily */
	load: () => Promise<StepFunction>;
}

/**
 * Registry of all available workflow steps
 *
 * To add a new step:
 * 1. Create a step file in ./steps/<step-name>.ts
 * 2. Export a function matching the StepFunction signature
 * 3. Add an entry here mapping the node type to the step
 */
export const stepRegistry: Record<string, StepRegistryEntry> = {
	// Core steps
	trigger: {
		name: "Trigger",
		load: async () => {
			const mod = await import("./steps/trigger");
			return mod.executeTriggerStep;
		},
	},
	condition: {
		name: "Condition",
		load: async () => {
			const mod = await import("./steps/condition");
			return mod.executeConditionStep;
		},
	},
	"http-request": {
		name: "HTTP Request",
		load: async () => {
			const mod = await import("./steps/http-request");
			return mod.executeHttpRequestStep;
		},
	},

	// AI Gateway steps
	"ai-generate-text": {
		name: "Generate Text",
		load: async () => {
			const mod = await import("./steps/ai-generate-text");
			return mod.executeAiGenerateTextStep;
		},
	},
	"ai-generate-image": {
		name: "Generate Image",
		load: async () => {
			const mod = await import("./steps/ai-generate-image");
			return mod.executeAiGenerateImageStep;
		},
	},

	// Firecrawl steps
	"firecrawl-scrape": {
		name: "Firecrawl Scrape",
		load: async () => {
			const mod = await import("./steps/firecrawl-scrape");
			return mod.executeFirecrawlScrapeStep;
		},
	},

	"bitbucket-create-issue": {
		name: "Create Bitbucket Issue",
		load: async () => {
			const mod = await import("./steps/bitbucket-create-issue");
			return mod.executeBitbucketCreateIssueStep;
		},
	},
	"bitbucket-search-issues": {
		name: "Search Bitbucket Issues",
		load: async () => {
			const mod = await import("./steps/bitbucket-search-issues");
			return mod.executeBitbucketSearchIssuesStep;
		},
	},
	"firecrawl-search": {
		name: "Firecrawl Search",
		load: async () => {
			const mod = await import("./steps/firecrawl-search");
			return mod.executeFirecrawlSearchStep;
		},
	},

	// Productivity steps
	"clickup-create-task": {
		name: "Create ClickUp Task",
		load: async () => {
			const mod = await import("./steps/clickup-create-task");
			return mod.executeClickUpCreateTaskStep;
		},
	},
	"clickup-search-tasks": {
		name: "Search ClickUp Tasks",
		load: async () => {
			const mod = await import("./steps/clickup-search-tasks");
			return mod.executeClickUpSearchTasksStep;
		},
	},
	"jira-create-issue": {
		name: "Create Jira Issue",
		load: async () => {
			const mod = await import("./steps/jira-create-issue");
			return mod.executeJiraCreateIssueStep;
		},
	},
	"jira-search-issues": {
		name: "Search Jira Issues",
		load: async () => {
			const mod = await import("./steps/jira-search-issues");
			return mod.executeJiraSearchIssuesStep;
		},
	},
	"linear-create-ticket": {
		name: "Create Linear Ticket",
		load: async () => {
			const mod = await import("./steps/linear-create-ticket");
			return mod.executeLinearCreateTicketStep;
		},
	},
	"linear-find-issues": {
		name: "Find Linear Issues",
		load: async () => {
			const mod = await import("./steps/linear-find-issues");
			return mod.executeLinearFindIssuesStep;
		},
	},

	// Communication steps
	"slack-send": {
		name: "Send Slack Message",
		load: async () => {
			const mod = await import("./steps/slack-send");
			return mod.executeSlackSendStep;
		},
	},
	"email-send": {
		name: "Send Email",
		load: async () => {
			const mod = await import("./steps/email-send");
			return mod.executeEmailSendStep;
		},
	},

	// MCP steps
	"mcp-tool": {
		name: "MCP Tool",
		load: async () => {
			const mod = await import("./steps/mcp-tool");
			return mod.executeMcpToolStep;
		},
	},

	// GitHub steps
	"github-create-issue": {
		name: "Create GitHub Issue",
		load: async () => {
			const mod = await import("./steps/github-create-issue");
			return mod.executeGithubCreateIssueStep;
		},
	},
	"github-search-issues": {
		name: "Search GitHub Issues",
		load: async () => {
			const mod = await import("./steps/github-search-issues");
			return mod.executeGithubSearchIssuesStep;
		},
	},
	"github-get-file": {
		name: "Get GitHub File",
		load: async () => {
			const mod = await import("./steps/github-get-file");
			return mod.executeGithubGetFileStep;
		},
	},
	"github-get-diff": {
		name: "Get GitHub Diff",
		load: async () => {
			const mod = await import("./steps/github-get-diff");
			return mod.executeGithubGetDiffStep;
		},
	},
	"gitlab-create-issue": {
		name: "Create GitLab Issue",
		load: async () => {
			const mod = await import("./steps/gitlab-create-issue");
			return mod.executeGitLabCreateIssueStep;
		},
	},
	"gitlab-search-issues": {
		name: "Search GitLab Issues",
		load: async () => {
			const mod = await import("./steps/gitlab-search-issues");
			return mod.executeGitLabSearchIssuesStep;
		},
	},
	"gitlab-get-file": {
		name: "Get GitLab File",
		load: async () => {
			const mod = await import("./steps/gitlab-get-file");
			return mod.executeGitLabGetFileStep;
		},
	},
	"hubspot-create-contact": {
		name: "Create HubSpot Contact",
		load: async () => {
			const mod = await import("./steps/hubspot-create-contact");
			return mod.executeHubSpotCreateContactStep;
		},
	},
	"hubspot-search-contacts": {
		name: "Search HubSpot Contacts",
		load: async () => {
			const mod = await import("./steps/hubspot-search-contacts");
			return mod.executeHubSpotSearchContactsStep;
		},
	},
	"intercom-create-contact": {
		name: "Create Intercom Contact",
		load: async () => {
			const mod = await import("./steps/intercom-create-contact");
			return mod.executeIntercomCreateContactStep;
		},
	},
	"intercom-search-conversations": {
		name: "Search Intercom Conversations",
		load: async () => {
			const mod = await import("./steps/intercom-search-conversations");
			return mod.executeIntercomSearchConversationsStep;
		},
	},

	// Perplexity steps
	"perplexity-search": {
		name: "Perplexity Search",
		load: async () => {
			const mod = await import("./steps/perplexity-search");
			return mod.executePerplexitySearchStep;
		},
	},

	// fal.ai steps
	"fal-generate-image": {
		name: "fal.ai Generate Image",
		load: async () => {
			const mod = await import("./steps/fal-generate-image");
			return mod.executeFalGenerateImageStep;
		},
	},
	"fal-generate-video": {
		name: "fal.ai Generate Video",
		load: async () => {
			const mod = await import("./steps/fal-generate-video");
			return mod.executeFalGenerateVideoStep;
		},
	},

	// Browser automation steps (CUGA-inspired)
	"browser-navigate": {
		name: "Browser Navigate",
		load: async () => {
			const mod = await import("./steps/browser-navigate");
			return mod.executeBrowserNavigateStep;
		},
	},
	"browser-extract": {
		name: "Browser Extract",
		load: async () => {
			const mod = await import("./steps/browser-extract");
			return mod.executeBrowserExtractStep;
		},
	},
	"browser-screenshot": {
		name: "Browser Screenshot",
		load: async () => {
			const mod = await import("./steps/browser-screenshot");
			return mod.executeBrowserScreenshotStep;
		},
	},
	"browser-action": {
		name: "Browser Action",
		load: async () => {
			const mod = await import("./steps/browser-action");
			return mod.executeBrowserActionStep;
		},
	},

	// Hybrid execution step (API + Browser with fallback)
	"hybrid-step": {
		name: "Hybrid API/Browser",
		load: async () => {
			const mod = await import("./steps/hybrid-step");
			return mod.executeHybridStep;
		},
	},

	// Asana steps
	"asana-create-task": {
		name: "Create Asana Task",
		load: async () => {
			const mod = await import("./steps/asana-create-task");
			return mod.executeAsanaCreateTaskStep;
		},
	},
	"asana-list-tasks": {
		name: "List Asana Tasks",
		load: async () => {
			const mod = await import("./steps/asana-list-tasks");
			return mod.executeAsanaListTasksStep;
		},
	},

	// Attio steps
	"attio-create-record": {
		name: "Create Attio Record",
		load: async () => {
			const mod = await import("./steps/attio-create-record");
			return mod.executeAttioCreateRecordStep;
		},
	},
	"attio-search-records": {
		name: "Search Attio Records",
		load: async () => {
			const mod = await import("./steps/attio-search-records");
			return mod.executeAttioSearchRecordsStep;
		},
	},

	// Canva steps
	"canva-list-designs": {
		name: "List Canva Designs",
		load: async () => {
			const mod = await import("./steps/canva-list-designs");
			return mod.executeCanvaListDesignsStep;
		},
	},

	// Front steps
	"front-create-conversation": {
		name: "Create Front Conversation",
		load: async () => {
			const mod = await import("./steps/front-create-conversation");
			return mod.executeFrontCreateConversationStep;
		},
	},
	"front-list-conversations": {
		name: "List Front Conversations",
		load: async () => {
			const mod = await import("./steps/front-list-conversations");
			return mod.executeFrontListConversationsStep;
		},
	},

	// Freshservice steps
	"freshservice-create-ticket": {
		name: "Create Freshservice Ticket",
		load: async () => {
			const mod = await import("./steps/freshservice-create-ticket");
			return mod.executeFreshserviceCreateTicketStep;
		},
	},
	"zendesk-create-ticket": {
		name: "Create Zendesk Ticket",
		load: async () => {
			const mod = await import("./steps/zendesk-create-ticket");
			return mod.executeZendeskCreateTicketStep;
		},
	},
	"zendesk-search-tickets": {
		name: "Search Zendesk Tickets",
		load: async () => {
			const mod = await import("./steps/zendesk-search-tickets");
			return mod.executeZendeskSearchTicketsStep;
		},
	},
	"salesforce-create-lead": {
		name: "Create Salesforce Lead",
		load: async () => {
			const mod = await import("./steps/salesforce-create-lead");
			return mod.executeSalesforceCreateLeadStep;
		},
	},
	"salesforce-query-records": {
		name: "Query Salesforce Records",
		load: async () => {
			const mod = await import("./steps/salesforce-query-records");
			return mod.executeSalesforceQueryRecordsStep;
		},
	},

	// Ported from vercel-labs/workflow-builder-template
	"stripe-create-customer": {
		name: "Create Stripe Customer",
		load: async () => {
			const mod = await import("./steps/stripe-create-customer");
			return mod.executeStripeCreateCustomerStep;
		},
	},
	"stripe-get-customer": {
		name: "Get Stripe Customer",
		load: async () => {
			const mod = await import("./steps/stripe-get-customer");
			return mod.executeStripeGetCustomerStep;
		},
	},
	"stripe-create-invoice": {
		name: "Create Stripe Invoice",
		load: async () => {
			const mod = await import("./steps/stripe-create-invoice");
			return mod.executeStripeCreateInvoiceStep;
		},
	},
	"webflow-list-sites": {
		name: "List Webflow Sites",
		load: async () => {
			const mod = await import("./steps/webflow-list-sites");
			return mod.executeWebflowListSitesStep;
		},
	},
	"webflow-get-site": {
		name: "Get Webflow Site",
		load: async () => {
			const mod = await import("./steps/webflow-get-site");
			return mod.executeWebflowGetSiteStep;
		},
	},
	"webflow-publish-site": {
		name: "Publish Webflow Site",
		load: async () => {
			const mod = await import("./steps/webflow-publish-site");
			return mod.executeWebflowPublishSiteStep;
		},
	},
	"superagent-guard": {
		name: "Superagent Guard",
		load: async () => {
			const mod = await import("./steps/superagent-guard");
			return mod.executeSuperagentGuardStep;
		},
	},
	"superagent-redact": {
		name: "Superagent Redact",
		load: async () => {
			const mod = await import("./steps/superagent-redact");
			return mod.executeSuperagentRedactStep;
		},
	},
	"clerk-get-user": {
		name: "Get Clerk User",
		load: async () => {
			const mod = await import("./steps/clerk-get-user");
			return mod.executeClerkGetUserStep;
		},
	},
	"clerk-create-user": {
		name: "Create Clerk User",
		load: async () => {
			const mod = await import("./steps/clerk-create-user");
			return mod.executeClerkCreateUserStep;
		},
	},
	"clerk-update-user": {
		name: "Update Clerk User",
		load: async () => {
			const mod = await import("./steps/clerk-update-user");
			return mod.executeClerkUpdateUserStep;
		},
	},
	"clerk-delete-user": {
		name: "Delete Clerk User",
		load: async () => {
			const mod = await import("./steps/clerk-delete-user");
			return mod.executeClerkDeleteUserStep;
		},
	},
	"blob-put": {
		name: "Upload to Vercel Blob",
		load: async () => {
			const mod = await import("./steps/blob-put");
			return mod.executeBlobPutStep;
		},
	},
	"blob-list": {
		name: "List Vercel Blobs",
		load: async () => {
			const mod = await import("./steps/blob-list");
			return mod.executeBlobListStep;
		},
	},
};

/**
 * Re-exported from the workflow-safe classification module so the durable
 * workflow and the activity layer share one definition. The registry stays the
 * semantic home for "which steps write", but the constant itself must live
 * somewhere a Temporal workflow can import without dragging the step modules
 * (and their database/Node dependencies) into the workflow bundle.
 */
export {
	EXTERNAL_WRITE_NODE_TYPES,
	isExternalWriteNodeType,
	isNonRetryableNodeType,
	LEGACY_NODE_TYPE_ALIASES,
	resolveNodeType,
};

/**
 * Check if a step exists in the registry, resolving legacy node types.
 */
export function hasStep(nodeType: string): boolean {
	return resolveNodeType(nodeType) in stepRegistry;
}

/**
 * Get step metadata by node type, resolving legacy node types.
 */
export function getStepInfo(nodeType: string): StepRegistryEntry | undefined {
	return stepRegistry[resolveNodeType(nodeType)];
}

/**
 * Load and execute a step by node type
 * This is the main entry point used by executeWorkflowNode
 */
export async function executeStep(
	nodeType: string,
	params: StepParams,
): Promise<NodeExecutionResult> {
	const resolved = resolveNodeType(nodeType);
	const entry = stepRegistry[resolved];

	if (!entry) {
		// Fail closed. Returning success here made a workflow that referenced a
		// missing step report a green run that did nothing — which is how the
		// registry drifted from the plugin definitions unnoticed.
		console.error(`[Step Registry] Unknown node type: ${nodeType}`);
		return {
			success: false,
			error: `Unknown node type: ${nodeType}`,
		};
	}

	// Lazy load the step function
	const stepFn = await entry.load();

	// Execute the step
	return stepFn(params);
}

/**
 * Get all registered node types
 */
export function getRegisteredNodeTypes(): string[] {
	return Object.keys(stepRegistry);
}
