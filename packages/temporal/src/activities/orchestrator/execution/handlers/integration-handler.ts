/**
 * Integration Handler
 *
 * Handles step execution for workflow integrations like Slack, GitHub, Linear, etc.
 * Uses configured integrations from the WorkflowIntegration table.
 *
 * This handler allows the orchestrator to use configured integrations directly
 * without requiring MCP servers for common services.
 */

import type { WorkflowIntegrationProvider } from "@repo/database";
import {
	fetchCredentialsByIdAndProviderInTenant,
	fetchCredentialsByProvider,
} from "@repo/database";
import type { OperationDefinition } from "@repo/integrations/executor-registry";
import {
	executeRegisteredIntegrationOperation,
	getIntegrationOperationKeywords,
	isRegisteredIntegrationProvider,
	listIntegrationOperationNames,
	listRegisteredIntegrationProviders,
	resolveIntegrationOperation,
} from "@repo/integrations/executor-registry";
import { executeMicrosoftTeamsTool } from "../../../shared/oauth-tool-executors";
import { guardToolWriteForReadOnly } from "../../../shared/read-only-gate";
import type { ExecuteStepInput } from "../../types";
import type { HandlerContext, HandlerResult, StepHandler } from "./types";

/**
 * Integration operations still implemented by this handler's own switch.
 *
 * Providers with a shared executor are NOT listed here — their operations come
 * from `@repo/integrations/executor-registry` via
 * {@link getSupportedIntegrationOperations}, so discovery, the chat path and
 * this handler can never disagree about what a provider supports.
 */
const LEGACY_INTEGRATION_OPERATIONS: Record<string, string[]> = {
	SLACK: [
		"send_message",
		"post_notification",
		"send_dm",
		"get_channel_history",
		"read_messages",
	],
	GITHUB: [
		"create_issue",
		"create_pr",
		"list_issues",
		"get_repo",
		"create_comment",
	],
	GITLAB: [
		"create_issue",
		"create_merge_request",
		"list_issues",
		"get_project",
		"list_merge_requests",
		"get_file_contents",
	],
	LINEAR: ["create_issue", "list_issues", "update_issue", "get_issue"],
	RESEND: ["send_email"],
	PERPLEXITY: ["search", "ask"],
	FIRECRAWL: ["scrape_url", "crawl_site"],
	FAL: ["generate_image", "run_model"],
	CUSTOM_WEBHOOK: ["call_webhook"],
	MICROSOFT_GRAPH: [
		// Teams Messaging (most common - should be first for default fallback)
		"list_teams",
		"list_channels",
		"list_messages",
		"get_chat_messages",
		"list_chats",
		"search_messages",
		// Teams Meetings
		"list_meetings",
		"get_transcript",
		"get_transcript_by_url",
		// Email
		"get_emails",
		"send_email",
		// Calendar
		"get_calendar_events",
		"create_calendar_event",
		// Files
		"search_files",
		"get_file_content",
		"get_shared_files",
		// User
		"get_profile",
	],
};

/**
 * Providers this handler ADVERTISES, legacy switch plus shared registry. Used
 * for step-to-provider matching, not as proof of executability: `FAL` is
 * declared in the legacy map but has no dispatch case, so a FAL step matches
 * here and then fails with "Unsupported integration provider" (pre-existing
 * drift, tracked separately — do not read this list as a routing guarantee).
 */
const SUPPORTED_INTEGRATION_PROVIDERS: string[] = [
	...Object.keys(LEGACY_INTEGRATION_OPERATIONS),
	...listRegisteredIntegrationProviders(),
];

const SUPPORTED_INTEGRATION_PROVIDERS_LOWER: string[] =
	SUPPORTED_INTEGRATION_PROVIDERS.map((provider) => provider.toLowerCase());

/** Operations a provider supports, from whichever source owns it. */
function getSupportedIntegrationOperations(provider: string): string[] {
	return isRegisteredIntegrationProvider(provider)
		? listIntegrationOperationNames(provider)
		: (LEGACY_INTEGRATION_OPERATIONS[provider] ?? []);
}

/**
 * Integration Handler for executing workflow integration steps.
 */
export class IntegrationHandler implements StepHandler {
	readonly name = "IntegrationHandler";
	readonly capabilities = [
		"integration",
		"slack",
		"github",
		"linear",
		"resend",
		"email",
		"microsoft",
		"microsoft_graph",
		"teams",
		"outlook",
		"onedrive",
		"nhtsa",
		"nhtsa_vpic",
		"vehicle",
		"vin",
		"vector_search",
		"semantic_search",
		"knowledge_retrieval",
	];

	/**
	 * Check if this handler can process the step.
	 * Handles steps with integration capability or matched integrations.
	 *
	 * IMPORTANT: Steps with an explicit non-integration capability (e.g., "llm",
	 * "agent", "web") must NOT be claimed by this handler. The planner deliberately
	 * assigns capabilities to control routing — description-based matching must
	 * only apply when no specific capability is set or when it's "integration".
	 */
	canHandle(input: ExecuteStepInput): boolean {
		const { step, matchedIntegrations } = input;
		const capability = step.capability;

		// If the planner explicitly set a non-integration capability, never claim it.
		// This prevents misrouting LLM summary steps, agent steps, etc. to integrations
		// just because the step description mentions an integration keyword.
		if (
			capability &&
			capability !== "integration" &&
			capability !== "mcp_tool"
		) {
			return false;
		}

		// Check if step has integration capability
		if (capability === "integration") {
			return true;
		}

		// Check if step executor matches an integration provider
		const executor = step.executor?.toLowerCase();
		if (
			executor &&
			SUPPORTED_INTEGRATION_PROVIDERS_LOWER.includes(executor)
		) {
			return true;
		}

		// Check if matched integrations can handle this step
		if (matchedIntegrations?.length) {
			const stepDesc = step.description.toLowerCase();
			const stepApp = step.app?.toLowerCase();

			for (const integration of matchedIntegrations) {
				const providerLower = integration.provider.toLowerCase();
				if (
					stepDesc.includes(providerLower) ||
					stepApp === providerLower ||
					integration.capabilities.some((cap: string) =>
						stepDesc.includes(cap.replace(/_/g, " ")),
					)
				) {
					return true;
				}
			}
		}

		return false;
	}

	/**
	 * Execute the step using a workflow integration.
	 */
	async execute(context: HandlerContext): Promise<HandlerResult> {
		const { input } = context;
		const { step, userId, organizationId, matchedIntegrations } = input;
		const startTime = Date.now();

		console.log(`[IntegrationHandler] Executing step: ${step.id}`);

		try {
			// Determine which integration to use
			const integration = this.resolveIntegration(
				input,
				matchedIntegrations,
			);
			if (!integration) {
				return {
					handled: false,
					shouldFallback: true,
					fallbackReason: "No matching integration found for step",
				};
			}

			// Track if this integration was explicitly matched (from routing)
			// If so, we should NOT fall back to MCP tools on failure - this prevents
			// security issues where unrelated tools (like Fizzy) get called for Slack requests
			const isExplicitlyMatched = matchedIntegrations?.some(
				(mi) =>
					mi.provider === integration.provider && mi.confidence > 0.5,
			);

			console.log(
				`[IntegrationHandler] Using integration: ${integration.name} (${integration.provider})`,
				{ isExplicitlyMatched },
			);

			// Determine the operation to perform
			const operation = this.resolveOperation(step, integration.provider);
			console.log(`[IntegrationHandler] Operation: ${operation}`);

			// ── Registry resolution BEFORE the gates ───────────────────────
			// An operation the shared executor cannot run must be reported as
			// unsupported, not as an authority or Read-only refusal, and its
			// declared access is what the Read-only gate below is entitled to
			// trust. Unregistered providers keep the legacy name heuristic.
			let registeredOperation: OperationDefinition | undefined;
			if (isRegisteredIntegrationProvider(integration.provider)) {
				try {
					registeredOperation = resolveIntegrationOperation(
						integration.provider,
						operation,
					);
				} catch (error) {
					return {
						handled: false,
						error:
							error instanceof Error
								? error.message
								: String(error),
						shouldFallback: false,
					};
				}
			}

			// ── Authority gate: check runtime authority for this provider ──
			try {
				const { checkIntegrationAuthority } = await import(
					"../authority-gate"
				);
				const authorityResult = await checkIntegrationAuthority({
					userId,
					organizationId,
					provider: integration.provider,
					operation,
					runType: "ORCHESTRATOR",
					runId: input.executionId,
				});
				if (!authorityResult.authorized) {
					console.log(
						`[IntegrationHandler] Authority denied for ${integration.provider}/${operation}: ${authorityResult.reason}`,
					);
					return {
						handled: true,
						output: {
							status: "failed" as const,
							outputs: {
								error: `Runtime authority required for ${integration.name}. ${authorityResult.reason}`,
								authorityRequired: true,
								providerKey: authorityResult.providerKey,
								requiredAccessLevel:
									authorityResult.requiredAccessLevel,
							},
							response: `I need runtime authority to use ${integration.name} (${authorityResult.requiredAccessLevel} access for "${authorityResult.providerKey}"). Please grant authority and try again.`,
							toolCalls: [],
						},
					};
				}
			} catch (error) {
				// Fail closed — authority check errors block execution
				console.error(
					"[IntegrationHandler] Authority check error, blocking execution:",
					error,
				);
				return {
					handled: true,
					output: {
						status: "failed" as const,
						outputs: {
							error: `Authority check failed: ${error instanceof Error ? error.message : String(error)}`,
						},
						response:
							"Unable to verify runtime authority. Please try again.",
						toolCalls: [],
					},
				};
			}

			// ── Read-only mode gate ──────────────────────
			// This handler dispatches direct integration writes (Slack
			// chat.postMessage, Teams send_message, GitLab create) OUTSIDE
			// the MCP funnel, so it gates here on the resolved operation.
			// projectId is on the step input; a write op to a read-only
			// project is blocked before any external call. Registered
			// providers supply their declared access so the gate does not
			// have to guess from the operation name.
			const readOnlyBlock = await guardToolWriteForReadOnly(
				input.projectId,
				operation,
				registeredOperation
					? { accessOverride: registeredOperation.access }
					: undefined,
			);
			if (readOnlyBlock) {
				return {
					handled: true,
					output: {
						status: "failed" as const,
						outputs: {
							error: readOnlyBlock.error,
							errorCode: readOnlyBlock.code,
						},
						response: readOnlyBlock.error,
						toolCalls: [],
					},
				};
			}

			// Fetch credentials for the integration. When an ID is known it must
			// also match the provider we are about to execute — an ID alone
			// would let a step declare NHTSA_VPIC, point at an active row from
			// some other provider, and satisfy NHTSA's credentialless policy
			// without the tenant having NHTSA configured at all.
			const credentials = integration.integrationId
				? await fetchCredentialsByIdAndProviderInTenant(
						integration.integrationId,
						integration.provider as WorkflowIntegrationProvider,
						userId,
						organizationId,
					)
				: await fetchCredentialsByProvider(
						integration.provider as WorkflowIntegrationProvider,
						userId,
						organizationId,
					);

			if (!credentials) {
				return {
					handled: false,
					error: `${integration.provider} integration not configured. Please configure it in Settings > Integrations.`,
					shouldFallback: false,
				};
			}

			// Execute the integration operation
			const result = await this.executeIntegrationOperation(
				integration.provider,
				operation,
				credentials,
				step,
				context,
			);

			const durationMs = Date.now() - startTime;
			console.log(`[IntegrationHandler] Completed in ${durationMs}ms`);

			if (result.success) {
				return {
					handled: true,
					output: {
						stepId: step.id,
						status: "completed",
						response: result.output || "",
						outputs: {
							integration_result: result.data,
						},
						variables: {
							integration_result: {
								name: "integration_result",
								value: JSON.stringify(result.data || {}),
								setBy: step.id,
								setAt: new Date().toISOString(),
								scope: "workflow",
							},
						},
						toolCalls: [
							{
								id: `integration-${Date.now()}`,
								name: `${integration.provider}.${operation}`,
								args: step.inputs || {},
								result: result.data,
								status: "success",
								durationMs,
							},
						],
					},
				};
			}
			// SECURITY: Don't fall back to MCP tools when an integration was explicitly matched
			// This prevents unrelated tools (like Fizzy) from being used for Slack requests
			if (isExplicitlyMatched) {
				console.warn(
					`[IntegrationHandler] Integration ${integration.provider} failed, NOT falling back to MCP (security)`,
					{ error: result.error },
				);
				return {
					handled: false,
					error: `${integration.provider} integration failed: ${result.error}. Please check your integration configuration.`,
					shouldFallback: false,
				};
			}

			return {
				handled: false,
				error: result.error,
				shouldFallback: true,
				fallbackReason: `Integration ${integration.provider} failed: ${result.error}`,
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			console.error(`[IntegrationHandler] Error: ${errorMessage}`);

			// Don't fall back on errors either - return clear error message
			return {
				handled: false,
				error: `Integration execution error: ${errorMessage}`,
				shouldFallback: false,
			};
		}
	}

	/**
	 * Resolve which integration to use for the step.
	 */
	private resolveIntegration(
		input: ExecuteStepInput,
		matchedIntegrations?: ExecuteStepInput["matchedIntegrations"],
	): { name: string; provider: string; integrationId?: string } | null {
		const { step } = input;

		// Check step inputs for explicit integration
		if (step.inputs?.integrationId) {
			return {
				name: String(step.inputs.integrationName || "Unknown"),
				provider: String(
					step.inputs.integrationProvider ||
						step.executor ||
						"UNKNOWN",
				),
				integrationId: String(step.inputs.integrationId),
			};
		}

		// Check matched integrations from routing
		if (matchedIntegrations?.length) {
			const stepDesc = step.description.toLowerCase();
			const stepApp = step.app?.toLowerCase();
			const executor = step.executor?.toLowerCase();

			// Find best matching integration
			for (const integration of matchedIntegrations) {
				const providerLower = integration.provider.toLowerCase();
				if (
					executor === providerLower ||
					stepApp === providerLower ||
					stepDesc.includes(providerLower)
				) {
					return {
						name: integration.name,
						provider: integration.provider,
						integrationId: integration.integrationId,
					};
				}
			}

			// Use highest confidence match if no direct match
			const topMatch = matchedIntegrations[0];
			if (topMatch.confidence > 0.5) {
				return {
					name: topMatch.name,
					provider: topMatch.provider,
					integrationId: topMatch.integrationId,
				};
			}
		}

		// Infer from step executor or description
		const executor = step.executor?.toUpperCase();
		if (executor && SUPPORTED_INTEGRATION_PROVIDERS.includes(executor)) {
			return { name: executor, provider: executor };
		}

		// Try to match from step description
		const stepDesc = step.description.toLowerCase();
		for (const provider of SUPPORTED_INTEGRATION_PROVIDERS) {
			if (stepDesc.includes(provider.toLowerCase())) {
				return { name: provider, provider };
			}
		}

		return null;
	}

	/**
	 * Semantic keyword mappings to operations by provider.
	 * Maps natural language keywords to specific operations.
	 *
	 * Registered providers are absent here on purpose — their cues live beside
	 * their executor in the shared registry.
	 */
	private static readonly LEGACY_OPERATION_KEYWORDS: Record<
		string,
		Record<string, string[]>
	> = {
		SLACK: {
			get_channel_history: [
				"read",
				"fetch",
				"get messages",
				"retrieve",
				"history",
				"channel messages",
				"past messages",
				"recent messages",
				"what happened",
				"summarize channel",
				"digest",
				"activity",
			],
			send_message: [
				"send",
				"post",
				"write",
				"notify",
				"tell",
				"message to",
			],
			send_dm: ["direct message", "dm ", "private message"],
		},
		GITHUB: {
			list_issues: ["list", "get issues", "fetch issues", "show issues"],
			create_issue: [
				"create issue",
				"new issue",
				"open issue",
				"file issue",
			],
		},
		GITLAB: {
			list_issues: ["list", "get issues", "fetch issues", "show issues"],
			create_issue: [
				"create issue",
				"new issue",
				"open issue",
				"file issue",
			],
			create_merge_request: [
				"create mr",
				"new merge request",
				"open mr",
				"create merge request",
			],
			list_merge_requests: [
				"list mrs",
				"get merge requests",
				"show merge requests",
			],
		},
		LINEAR: {
			list_issues: ["list", "get issues", "fetch issues", "show issues"],
			create_issue: ["create issue", "new issue", "open issue"],
		},
		MICROSOFT_GRAPH: {
			// Search (uses /search/query - no IDs required)
			search_messages: [
				"search message",
				"find message",
				"search teams",
				"search in teams",
			],
			// Team channel operations
			list_messages: [
				"channel message",
				"messages in channel",
				"channel history",
			],
			list_teams: ["list teams", "my teams", "show teams", "get teams"],
			list_channels: ["list channels", "show channels", "get channels"],
			// Direct/group chat operations
			list_chats: [
				"list chats",
				"my chats",
				"show chats",
				"direct messages",
			],
			get_chat_messages: ["chat message", "messages in chat"],
			// Meeting operations
			list_meetings: [
				"list meetings",
				"my meetings",
				"show meetings",
				"upcoming meetings",
				"scheduled meetings",
				"teams meetings",
			],
			get_transcript: [
				"transcript",
				"meeting transcript",
				"get transcript",
			],
			// Email operations
			get_emails: [
				"get email",
				"read email",
				"inbox",
				"my emails",
				"show emails",
				"outlook",
			],
			send_email: ["send email", "compose email", "write email"],
			// Calendar operations
			get_calendar_events: [
				"calendar",
				"events",
				"schedule",
				"appointments",
			],
			create_calendar_event: [
				"create event",
				"schedule meeting",
				"add to calendar",
			],
			// File operations
			search_files: [
				"search file",
				"find file",
				"onedrive",
				"sharepoint",
			],
			get_file_content: ["get file", "download file", "file content"],
			get_shared_files: [
				"shared files",
				"files in channel",
				"team files",
			],
		},
	};

	/**
	 * Resolve the operation to perform based on step description.
	 *
	 * NOTE: This is simple keyword matching for fallback only.
	 * The orchestrator/planner should provide explicit operation in step.inputs.
	 */
	private resolveOperation(
		step: ExecuteStepInput["step"],
		provider: string,
	): string {
		const stepDesc = step.description.toLowerCase();
		const operations = getSupportedIntegrationOperations(provider);

		// Check step inputs for explicit operation (preferred - set by planner)
		if (
			step.inputs?.operation &&
			typeof step.inputs.operation === "string"
		) {
			return step.inputs.operation;
		}

		// Fallback: try semantic keyword matching
		const keywordMap =
			getIntegrationOperationKeywords(provider) ??
			IntegrationHandler.LEGACY_OPERATION_KEYWORDS[provider];
		if (keywordMap) {
			for (const [operation, keywords] of Object.entries(keywordMap)) {
				for (const keyword of keywords) {
					if (stepDesc.includes(keyword)) {
						console.log(
							`[IntegrationHandler] Matched operation "${operation}" via keyword "${keyword}"`,
						);
						return operation;
					}
				}
			}
		}

		// Then try exact operation name matching
		for (const op of operations) {
			const opWords = op.replace(/_/g, " ");
			if (stepDesc.includes(opWords) || stepDesc.includes(op)) {
				return op;
			}
		}

		// Default to first operation (but log a warning)
		console.warn(
			`[IntegrationHandler] No operation matched for "${stepDesc}", defaulting to ${operations[0]}`,
		);
		return operations[0] || "execute";
	}

	/**
	 * Execute a specific integration operation.
	 */
	private async executeIntegrationOperation(
		provider: string,
		operation: string,
		credentials: Record<string, string>,
		step: ExecuteStepInput["step"],
		context: HandlerContext,
	): Promise<{
		success: boolean;
		output?: string;
		data?: unknown;
		error?: string;
	}> {
		const inputs = step.inputs || {};

		// Providers with a shared executor are dispatched through the registry,
		// which validates the operation name, the argument shapes and the
		// required credential keys before any network call. The switch below
		// only owns providers not yet migrated.
		if (isRegisteredIntegrationProvider(provider)) {
			// `operation` is this handler's routing field, not an argument —
			// strip it so it can't be mistaken for one during validation.
			const { operation: _routingField, ...operationArgs } = inputs;
			try {
				const result = await executeRegisteredIntegrationOperation({
					provider,
					operation,
					args: operationArgs,
					credentials,
				});
				return {
					success: true,
					output: result.text,
					data: result.data,
				};
			} catch (error) {
				return {
					success: false,
					error:
						error instanceof Error
							? error.message
							: `${provider} execution failed`,
				};
			}
		}

		switch (provider) {
			case "SLACK":
				return this.executeSlack(
					operation,
					credentials,
					inputs,
					context,
					step,
				);
			case "GITHUB":
				return this.executeGitHub(
					operation,
					credentials,
					inputs,
					context,
				);
			case "GITLAB":
				return this.executeGitLab(
					operation,
					credentials,
					inputs,
					context,
				);
			case "LINEAR":
				return this.executeLinear(
					operation,
					credentials,
					inputs,
					context,
				);
			case "RESEND":
				return this.executeResend(
					operation,
					credentials,
					inputs,
					context,
				);
			case "PERPLEXITY":
				return this.executePerplexity(
					operation,
					credentials,
					inputs,
					context,
				);
			case "FIRECRAWL":
				return this.executeFirecrawl(
					operation,
					credentials,
					inputs,
					context,
				);
			case "CUSTOM_WEBHOOK":
				return this.executeWebhook(
					operation,
					credentials,
					inputs,
					context,
				);
			case "MICROSOFT_GRAPH":
				return this.executeMicrosoftGraph(
					operation,
					credentials,
					inputs,
					context,
				);
			default:
				return {
					success: false,
					error: `Unsupported integration provider: ${provider}`,
				};
		}
	}

	/**
	 * Execute Slack operations.
	 */
	private async executeSlack(
		operation: string,
		credentials: Record<string, string>,
		inputs: Record<string, unknown>,
		_context: HandlerContext,
		step: ExecuteStepInput["step"],
	): Promise<{
		success: boolean;
		output?: string;
		data?: unknown;
		error?: string;
	}> {
		const token = credentials.SLACK_TOKEN;
		if (!token) {
			return { success: false, error: "Slack token not configured" };
		}

		// Slack OAuth tokens can start with xoxb- (bot) or xoxp- (user) or xoxa- (app)
		if (!token.startsWith("xox")) {
			return {
				success: false,
				error: 'Invalid token format: Slack Bot tokens should start with "xoxb-"',
			};
		}

		// Handle read operations
		if (
			operation === "get_channel_history" ||
			operation === "read_messages"
		) {
			return this.executeSlackReadMessages(
				token,
				inputs,
				step.description,
			);
		}

		// Handle write operations (send_message, post_notification, send_dm)
		const channel = (inputs.channel || inputs.slackChannel) as string;
		const message = (inputs.message ||
			inputs.slackMessage ||
			inputs.text) as string;

		if (!channel || !message) {
			return {
				success: false,
				error: "Channel and message are required",
			};
		}

		try {
			const response = await fetch(
				"https://slack.com/api/chat.postMessage",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${token}`,
					},
					body: JSON.stringify({
						channel,
						text: message,
					}),
				},
			);

			const result = await response.json();

			if (!result.ok) {
				let errorMessage =
					result.error || "Failed to send Slack message";
				if (result.error === "channel_not_found") {
					errorMessage = `Channel "${channel}" not found. Make sure the bot is invited.`;
				}
				return { success: false, error: errorMessage };
			}

			return {
				success: true,
				output: `Message sent to ${channel}`,
				data: { timestamp: result.ts, channel: result.channel },
			};
		} catch (error) {
			return {
				success: false,
				error:
					error instanceof Error
						? error.message
						: "Failed to send Slack message",
			};
		}
	}

	/**
	 * Extract channel name from step description (e.g., "#tf-test" or "channel tf-test")
	 */
	private extractChannelFromDescription(description: string): string | null {
		// Match #channel-name pattern
		const hashMatch = description.match(/#([\w-]+)/);
		if (hashMatch) {
			return hashMatch[1];
		}
		// Match "channel X" or "channel: X" pattern
		const channelMatch = description.match(/channel[:\s]+([#\w-]+)/i);
		if (channelMatch) {
			return channelMatch[1].replace(/^#/, "");
		}
		return null;
	}

	/**
	 * Resolve a channel name to its ID using Slack API.
	 */
	private async resolveSlackChannelId(
		token: string,
		channelName: string,
	): Promise<{ success: boolean; channelId?: string; error?: string }> {
		try {
			// List conversations to find the channel
			const response = await fetch(
				"https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=1000",
				{
					headers: { Authorization: `Bearer ${token}` },
				},
			);
			const result = await response.json();

			if (!result.ok) {
				return {
					success: false,
					error: `Failed to list channels: ${result.error}`,
				};
			}

			// Find channel by name (case-insensitive)
			const normalizedName = channelName.toLowerCase().replace(/^#/, "");
			const channel = result.channels?.find(
				(ch: any) => ch.name.toLowerCase() === normalizedName,
			);

			if (channel) {
				console.log(
					`[IntegrationHandler] Resolved channel "${channelName}" to ID: ${channel.id}`,
				);
				return { success: true, channelId: channel.id };
			}

			return {
				success: false,
				error: `Channel "${channelName}" not found. Make sure the bot is in the channel.`,
			};
		} catch (error) {
			return {
				success: false,
				error: `Failed to resolve channel: ${error}`,
			};
		}
	}

	/**
	 * Read messages from a Slack channel using conversations.history API.
	 */
	private async executeSlackReadMessages(
		token: string,
		inputs: Record<string, unknown>,
		stepDescription?: string,
	): Promise<{
		success: boolean;
		output?: string;
		data?: unknown;
		error?: string;
	}> {
		let channel = (inputs.channel ||
			inputs.slackChannel ||
			inputs.channelId) as string;
		const limit = (inputs.limit as number) || 100;
		const oldest = inputs.oldest as string | undefined; // Unix timestamp
		const latest = inputs.latest as string | undefined; // Unix timestamp

		// If no channel provided, try to extract from step description
		if (!channel && stepDescription) {
			const extractedChannel =
				this.extractChannelFromDescription(stepDescription);
			if (extractedChannel) {
				console.log(
					`[IntegrationHandler] Extracted channel "${extractedChannel}" from step description`,
				);
				// Resolve channel name to ID
				const resolved = await this.resolveSlackChannelId(
					token,
					extractedChannel,
				);
				if (resolved.success && resolved.channelId) {
					channel = resolved.channelId;
				} else {
					return {
						success: false,
						error:
							resolved.error ||
							`Could not resolve channel "${extractedChannel}"`,
					};
				}
			}
		}

		if (!channel) {
			return {
				success: false,
				error: "Channel ID is required to read messages. Specify a channel like #channel-name or provide channelId in inputs.",
			};
		}

		try {
			// Build query parameters
			const params = new URLSearchParams({
				channel,
				limit: String(limit),
			});

			if (oldest) {
				params.append("oldest", oldest);
			}
			if (latest) {
				params.append("latest", latest);
			}

			const response = await fetch(
				`https://slack.com/api/conversations.history?${params.toString()}`,
				{
					method: "GET",
					headers: {
						Authorization: `Bearer ${token}`,
					},
				},
			);

			const result = await response.json();

			if (!result.ok) {
				let errorMessage =
					result.error || "Failed to read Slack messages";
				if (result.error === "channel_not_found") {
					errorMessage = `Channel "${channel}" not found. Make sure the bot is invited to the channel.`;
				} else if (result.error === "not_in_channel") {
					errorMessage = `Bot is not in channel "${channel}". Please invite the bot to the channel first.`;
				} else if (result.error === "missing_scope") {
					errorMessage =
						"Bot lacks permission to read channel history. Required scope: channels:history (public) or groups:history (private).";
				}
				return { success: false, error: errorMessage };
			}

			// Format messages for easier consumption
			const messages = (result.messages || []).map((msg: any) => ({
				text: msg.text,
				user: msg.user,
				timestamp: msg.ts,
				datetime: new Date(
					Number.parseFloat(msg.ts) * 1000,
				).toISOString(),
				type: msg.type,
				subtype: msg.subtype,
				threadTs: msg.thread_ts,
				replyCount: msg.reply_count,
			}));

			const messageCount = messages.length;
			const formattedOutput = messages
				.map((m: any) => `[${m.datetime}] ${m.user}: ${m.text}`)
				.join("\n");

			return {
				success: true,
				output: `Retrieved ${messageCount} messages from channel:\n\n${formattedOutput}`,
				data: {
					messages,
					messageCount,
					hasMore: result.has_more,
					responseMetadata: result.response_metadata,
				},
			};
		} catch (error) {
			return {
				success: false,
				error:
					error instanceof Error
						? error.message
						: "Failed to read Slack messages",
			};
		}
	}

	/**
	 * Execute GitHub operations.
	 */
	private async executeGitHub(
		operation: string,
		credentials: Record<string, string>,
		inputs: Record<string, unknown>,
		_context: HandlerContext,
	): Promise<{
		success: boolean;
		output?: string;
		data?: unknown;
		error?: string;
	}> {
		const token = credentials.GITHUB_TOKEN;
		if (!token) {
			return { success: false, error: "GitHub token not configured" };
		}

		const headers = {
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github.v3+json",
			"Content-Type": "application/json",
		};

		const owner = inputs.owner as string;
		const repo = inputs.repo as string;

		switch (operation) {
			case "create_issue": {
				const title = inputs.title as string;
				const body = inputs.body as string;

				if (!owner || !repo || !title) {
					return {
						success: false,
						error: "owner, repo, and title are required",
					};
				}

				const response = await fetch(
					`https://api.github.com/repos/${owner}/${repo}/issues`,
					{
						method: "POST",
						headers,
						body: JSON.stringify({
							title,
							body,
							labels: inputs.labels,
						}),
					},
				);

				if (!response.ok) {
					const error = await response.text();
					return {
						success: false,
						error: `GitHub API error: ${error}`,
					};
				}

				const issue = await response.json();
				return {
					success: true,
					output: `Created issue #${issue.number}: ${issue.html_url}`,
					data: issue,
				};
			}

			case "list_issues": {
				let url: string;
				let description: string;

				if (owner && repo) {
					// List issues for a specific repo
					url = `https://api.github.com/repos/${owner}/${repo}/issues?state=${inputs.state || "open"}`;
					description = `issues in ${owner}/${repo}`;
				} else {
					// List all issues assigned to the authenticated user across all repos
					// This is more useful when user just says "list my github issues"
					url = `https://api.github.com/user/issues?state=${inputs.state || "open"}&filter=${inputs.filter || "all"}`;
					description = "your issues across all repositories";
				}

				const response = await fetch(url, { headers });

				if (!response.ok) {
					const error = await response.text();
					return {
						success: false,
						error: `GitHub API error: ${error}`,
					};
				}

				const issues = await response.json();

				// Format issues for display
				const formattedIssues = issues.map(
					(issue: {
						number: number;
						title: string;
						state: string;
						html_url: string;
						repository?: { full_name: string };
					}) => ({
						number: issue.number,
						title: issue.title,
						state: issue.state,
						url: issue.html_url,
						repo: issue.repository?.full_name || `${owner}/${repo}`,
					}),
				);

				return {
					success: true,
					output: `Found ${issues.length} ${description}`,
					data: formattedIssues,
				};
			}

			default:
				return {
					success: false,
					error: `Unsupported GitHub operation: ${operation}`,
				};
		}
	}

	/**
	 * Execute GitLab operations.
	 */
	private async executeGitLab(
		operation: string,
		credentials: Record<string, string>,
		inputs: Record<string, unknown>,
		_context: HandlerContext,
	): Promise<{
		success: boolean;
		output?: string;
		data?: unknown;
		error?: string;
	}> {
		const token =
			credentials.GITLAB_ACCESS_TOKEN || credentials.access_token;
		if (!token) {
			return { success: false, error: "GitLab token not configured" };
		}

		const headers = {
			Authorization: `Bearer ${token}`,
			Accept: "application/json",
			"Content-Type": "application/json",
		};

		const projectId = inputs.project_id as string;

		switch (operation) {
			case "create_issue": {
				const title = inputs.title as string;
				const description = inputs.description as string;

				if (!projectId || !title) {
					return {
						success: false,
						error: "project_id and title are required",
					};
				}

				const response = await fetch(
					`https://gitlab.com/api/v4/projects/${encodeURIComponent(projectId)}/issues`,
					{
						method: "POST",
						headers,
						body: JSON.stringify({
							title,
							description,
							labels: inputs.labels,
						}),
					},
				);

				if (!response.ok) {
					const error = await response.text();
					return {
						success: false,
						error: `GitLab API error: ${error}`,
					};
				}

				const issue = (await response.json()) as {
					iid: number;
					web_url: string;
				};
				return {
					success: true,
					output: `Created issue #${issue.iid}: ${issue.web_url}`,
					data: issue,
				};
			}

			case "list_issues": {
				const state = (inputs.state as string) || "opened";
				const url = projectId
					? `https://gitlab.com/api/v4/projects/${encodeURIComponent(projectId)}/issues?state=${state}`
					: `https://gitlab.com/api/v4/issues?state=${state}&scope=assigned_to_me`;

				const response = await fetch(url, { headers });

				if (!response.ok) {
					const error = await response.text();
					return {
						success: false,
						error: `GitLab API error: ${error}`,
					};
				}

				const issues = (await response.json()) as Array<{
					iid: number;
					title: string;
					state: string;
					web_url: string;
					references?: { full: string };
				}>;

				const formattedIssues = issues.map((issue) => ({
					number: issue.iid,
					title: issue.title,
					state: issue.state,
					url: issue.web_url,
					reference: issue.references?.full,
				}));

				return {
					success: true,
					output: `Found ${issues.length} issues`,
					data: formattedIssues,
				};
			}

			case "create_merge_request": {
				const title = inputs.title as string;
				const sourceBranch = inputs.source_branch as string;
				const targetBranch = inputs.target_branch as string;

				if (!projectId || !title || !sourceBranch || !targetBranch) {
					return {
						success: false,
						error: "project_id, title, source_branch, and target_branch are required",
					};
				}

				const mrResponse = await fetch(
					`https://gitlab.com/api/v4/projects/${encodeURIComponent(projectId)}/merge_requests`,
					{
						method: "POST",
						headers,
						body: JSON.stringify({
							title,
							source_branch: sourceBranch,
							target_branch: targetBranch,
							description: inputs.description || "",
						}),
					},
				);

				if (!mrResponse.ok) {
					const error = await mrResponse.text();
					return {
						success: false,
						error: `GitLab API error: ${error}`,
					};
				}

				const mr = (await mrResponse.json()) as {
					iid: number;
					web_url: string;
				};
				return {
					success: true,
					output: `Created merge request !${mr.iid}: ${mr.web_url}`,
					data: mr,
				};
			}

			case "get_project": {
				if (!projectId) {
					return {
						success: false,
						error: "project_id is required",
					};
				}

				const projResponse = await fetch(
					`https://gitlab.com/api/v4/projects/${encodeURIComponent(projectId)}`,
					{ headers },
				);

				if (!projResponse.ok) {
					const error = await projResponse.text();
					return {
						success: false,
						error: `GitLab API error: ${error}`,
					};
				}

				const project = await projResponse.json();
				return {
					success: true,
					output: `Project: ${(project as { path_with_namespace: string }).path_with_namespace}`,
					data: project,
				};
			}

			case "list_merge_requests": {
				const mrState = (inputs.state as string) || "opened";
				const mrListUrl = projectId
					? `https://gitlab.com/api/v4/projects/${encodeURIComponent(projectId)}/merge_requests?state=${mrState}`
					: `https://gitlab.com/api/v4/merge_requests?state=${mrState}&scope=assigned_to_me`;

				const mrListResponse = await fetch(mrListUrl, { headers });

				if (!mrListResponse.ok) {
					const error = await mrListResponse.text();
					return {
						success: false,
						error: `GitLab API error: ${error}`,
					};
				}

				const mergeRequests = (await mrListResponse.json()) as Array<{
					iid: number;
					title: string;
					state: string;
					web_url: string;
					source_branch: string;
					target_branch: string;
				}>;

				const formattedMRs = mergeRequests.map((mr) => ({
					number: mr.iid,
					title: mr.title,
					state: mr.state,
					url: mr.web_url,
					source_branch: mr.source_branch,
					target_branch: mr.target_branch,
				}));

				return {
					success: true,
					output: `Found ${mergeRequests.length} merge requests`,
					data: formattedMRs,
				};
			}

			case "get_file_contents": {
				const filePath = inputs.path as string;
				const ref = (inputs.ref as string) || "main";

				if (!projectId || !filePath) {
					return {
						success: false,
						error: "project_id and path are required",
					};
				}

				const fileResponse = await fetch(
					`https://gitlab.com/api/v4/projects/${encodeURIComponent(projectId)}/repository/files/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(ref)}`,
					{ headers },
				);

				if (!fileResponse.ok) {
					const error = await fileResponse.text();
					return {
						success: false,
						error: `GitLab API error: ${error}`,
					};
				}

				const file = (await fileResponse.json()) as {
					file_name: string;
					file_path: string;
					content: string | null;
					encoding: string;
					size: number;
				};

				if (!file.content || file.encoding !== "base64") {
					return {
						success: true,
						output: `File ${file.file_path} (binary, ${file.size} bytes)`,
						data: {
							path: file.file_path,
							size: file.size,
							content: "(binary file)",
						},
					};
				}

				const decoded = Buffer.from(file.content, "base64").toString(
					"utf-8",
				);
				return {
					success: true,
					output: `File ${file.file_path} (${file.size} bytes)`,
					data: {
						path: file.file_path,
						size: file.size,
						content: decoded,
					},
				};
			}

			default:
				return {
					success: false,
					error: `Unsupported GitLab operation: ${operation}`,
				};
		}
	}

	/**
	 * Execute Linear operations.
	 */
	private async executeLinear(
		operation: string,
		credentials: Record<string, string>,
		inputs: Record<string, unknown>,
		_context: HandlerContext,
	): Promise<{
		success: boolean;
		output?: string;
		data?: unknown;
		error?: string;
	}> {
		const apiKey = credentials.LINEAR_API_KEY;
		if (!apiKey) {
			return { success: false, error: "Linear API key not configured" };
		}

		const headers = {
			Authorization: apiKey,
			"Content-Type": "application/json",
		};

		switch (operation) {
			case "create_issue": {
				const title = inputs.title as string;
				const description = inputs.description as string;
				const teamId = (inputs.teamId ||
					credentials.LINEAR_TEAM_ID) as string;

				if (!title || !teamId) {
					return {
						success: false,
						error: "title and teamId are required",
					};
				}

				const mutation = `
					mutation CreateIssue($title: String!, $description: String, $teamId: String!) {
						issueCreate(input: { title: $title, description: $description, teamId: $teamId }) {
							success
							issue { id identifier title url }
						}
					}
				`;

				const response = await fetch("https://api.linear.app/graphql", {
					method: "POST",
					headers,
					body: JSON.stringify({
						query: mutation,
						variables: { title, description, teamId },
					}),
				});

				const result = await response.json();

				if (result.errors) {
					return { success: false, error: result.errors[0]?.message };
				}

				const issue = result.data?.issueCreate?.issue;
				return {
					success: true,
					output: `Created Linear issue: ${issue?.identifier}`,
					data: issue,
				};
			}

			default:
				return {
					success: false,
					error: `Unsupported Linear operation: ${operation}`,
				};
		}
	}

	/**
	 * Execute Resend (email) operations.
	 */
	private async executeResend(
		_operation: string,
		credentials: Record<string, string>,
		inputs: Record<string, unknown>,
		_context: HandlerContext,
	): Promise<{
		success: boolean;
		output?: string;
		data?: unknown;
		error?: string;
	}> {
		const apiKey = credentials.RESEND_API_KEY;
		if (!apiKey) {
			return { success: false, error: "Resend API key not configured" };
		}

		const to = inputs.to as string | string[];
		const subject = inputs.subject as string;
		const html = (inputs.html || inputs.body) as string;
		const from = (inputs.from ||
			credentials.RESEND_FROM_EMAIL ||
			"onboarding@resend.dev") as string;

		if (!to || !subject) {
			return { success: false, error: "to and subject are required" };
		}

		const response = await fetch("https://api.resend.com/emails", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ from, to, subject, html }),
		});

		if (!response.ok) {
			const error = await response.text();
			return { success: false, error: `Resend API error: ${error}` };
		}

		const result = await response.json();
		return {
			success: true,
			output: `Email sent to ${Array.isArray(to) ? to.join(", ") : to}`,
			data: result,
		};
	}

	/**
	 * Execute Perplexity search operations.
	 */
	private async executePerplexity(
		_operation: string,
		credentials: Record<string, string>,
		inputs: Record<string, unknown>,
		_context: HandlerContext,
	): Promise<{
		success: boolean;
		output?: string;
		data?: unknown;
		error?: string;
	}> {
		const apiKey = credentials.PERPLEXITY_API_KEY;
		if (!apiKey) {
			return {
				success: false,
				error: "Perplexity API key not configured",
			};
		}

		const query = (inputs.query || inputs.question) as string;
		if (!query) {
			return { success: false, error: "query is required" };
		}

		const response = await fetch(
			"https://api.perplexity.ai/chat/completions",
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model: "llama-3.1-sonar-small-128k-online",
					messages: [{ role: "user", content: query }],
				}),
			},
		);

		if (!response.ok) {
			const error = await response.text();
			return { success: false, error: `Perplexity API error: ${error}` };
		}

		const result = await response.json();
		const content = result.choices?.[0]?.message?.content;

		return {
			success: true,
			output: content,
			data: result,
		};
	}

	/**
	 * Execute Firecrawl scraping operations.
	 */
	private async executeFirecrawl(
		operation: string,
		credentials: Record<string, string>,
		inputs: Record<string, unknown>,
		_context: HandlerContext,
	): Promise<{
		success: boolean;
		output?: string;
		data?: unknown;
		error?: string;
	}> {
		const apiKey = credentials.FIRECRAWL_API_KEY;
		if (!apiKey) {
			return {
				success: false,
				error: "Firecrawl API key not configured",
			};
		}

		const url = inputs.url as string;
		if (!url) {
			return { success: false, error: "url is required" };
		}

		const endpoint =
			operation === "crawl_site"
				? "https://api.firecrawl.dev/v1/crawl"
				: "https://api.firecrawl.dev/v1/scrape";

		const response = await fetch(endpoint, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ url, formats: ["markdown"] }),
		});

		if (!response.ok) {
			const error = await response.text();
			return { success: false, error: `Firecrawl API error: ${error}` };
		}

		const result = await response.json();
		const content = result.data?.markdown || result.data?.content;

		return {
			success: true,
			output: content,
			data: result,
		};
	}

	/**
	 * Execute custom webhook operations.
	 */
	private async executeWebhook(
		_operation: string,
		credentials: Record<string, string>,
		inputs: Record<string, unknown>,
		_context: HandlerContext,
	): Promise<{
		success: boolean;
		output?: string;
		data?: unknown;
		error?: string;
	}> {
		const webhookUrl = (inputs.url || credentials.WEBHOOK_URL) as string;
		if (!webhookUrl) {
			return { success: false, error: "Webhook URL not configured" };
		}

		const method = ((inputs.method as string) || "POST").toUpperCase();
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			...(inputs.headers as Record<string, string>),
		};

		// Add secret if configured
		if (credentials.WEBHOOK_SECRET) {
			headers["X-Webhook-Secret"] = credentials.WEBHOOK_SECRET;
		}

		const response = await fetch(webhookUrl, {
			method,
			headers,
			body:
				method !== "GET"
					? JSON.stringify(inputs.body || inputs.payload || {})
					: undefined,
		});

		const responseText = await response.text();
		let responseData: unknown;
		try {
			responseData = JSON.parse(responseText);
		} catch {
			responseData = responseText;
		}

		if (!response.ok) {
			return {
				success: false,
				error: `Webhook error (${response.status}): ${responseText}`,
			};
		}

		return {
			success: true,
			output: "Webhook called successfully",
			data: responseData,
		};
	}

	/**
	 * Execute Microsoft Graph operations.
	 * Supports Teams meetings, Outlook email, calendar, and OneDrive/SharePoint files.
	 */
	private async executeMicrosoftGraph(
		operation: string,
		credentials: Record<string, string>,
		inputs: Record<string, unknown>,
		_context: HandlerContext,
	): Promise<{
		success: boolean;
		output?: string;
		data?: unknown;
		error?: string;
	}> {
		const accessToken = credentials.MICROSOFT_ACCESS_TOKEN;
		if (!accessToken) {
			return {
				success: false,
				error: "Microsoft Graph access token not configured. Please connect Microsoft 365 in Settings > Integrations.",
			};
		}

		const baseUrl = "https://graph.microsoft.com/v1.0";
		const betaUrl = "https://graph.microsoft.com/beta";

		const headers = {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
		};

		try {
			switch (operation) {
				// ========== Teams Messaging ==========
				// These operations use the shared oauth-tool-executors for consistency
				case "list_teams":
				case "list_channels":
				case "list_messages":
				case "get_chat_messages":
				case "list_chats":
				case "search_messages":
				case "get_shared_files": {
					// Delegate to the shared Microsoft Teams tool executor
					// Planner should provide proper inputs (query, teamId, channelId, etc.)
					const result = await executeMicrosoftTeamsTool(
						operation,
						inputs,
						_context.input.userId,
						_context.input.organizationId || undefined,
					);
					return {
						success: true,
						output: `Microsoft Teams ${operation} completed`,
						data: result,
					};
				}

				// ========== Teams Meetings ==========
				case "list_meetings": {
					const now = new Date();
					const startDateTime =
						(inputs.startDateTime as string) ||
						new Date(
							now.getTime() - 30 * 24 * 60 * 60 * 1000,
						).toISOString();
					const endDateTime =
						(inputs.endDateTime as string) ||
						new Date(
							now.getTime() + 30 * 24 * 60 * 60 * 1000,
						).toISOString();

					const params = new URLSearchParams();
					params.set("startDateTime", startDateTime);
					params.set("endDateTime", endDateTime);
					params.set(
						"$filter",
						"isOnlineMeeting eq true and onlineMeetingProvider eq 'teamsForBusiness'",
					);
					params.set("$top", String((inputs.limit as number) || 10));
					params.set(
						"$select",
						"id,subject,start,end,organizer,attendees,onlineMeeting,webLink",
					);
					params.set("$orderby", "start/dateTime desc");

					const response = await fetch(
						`${baseUrl}/me/calendarView?${params.toString()}`,
						{ headers },
					);

					if (!response.ok) {
						const errorText = await response.text();
						return {
							success: false,
							error: `Failed to list meetings: ${response.status} - ${errorText}`,
						};
					}

					const data = await response.json();
					const meetings = data.value || [];

					return {
						success: true,
						output: `Found ${meetings.length} Teams meetings`,
						data: {
							meetings: meetings.map((m: any) => ({
								id: m.id,
								subject: m.subject,
								start: m.start?.dateTime,
								end: m.end?.dateTime,
								organizer: m.organizer?.emailAddress?.name,
								attendeeCount: m.attendees?.length || 0,
								joinUrl: m.onlineMeeting?.joinUrl,
								webLink: m.webLink,
							})),
							totalCount: meetings.length,
						},
					};
				}

				case "get_transcript": {
					const meetingId = inputs.meetingId as string;
					if (!meetingId) {
						return {
							success: false,
							error: "meetingId is required",
						};
					}

					let transcriptId = inputs.transcriptId as string;

					if (!transcriptId) {
						// List available transcripts
						const transcriptsResponse = await fetch(
							`${betaUrl}/me/onlineMeetings/${meetingId}/transcripts`,
							{ headers },
						);

						if (!transcriptsResponse.ok) {
							const errorText = await transcriptsResponse.text();
							return {
								success: false,
								error: `Failed to list transcripts: ${transcriptsResponse.status} - ${errorText}`,
							};
						}

						const transcriptsData =
							await transcriptsResponse.json();
						const transcripts = transcriptsData.value || [];

						if (transcripts.length === 0) {
							return {
								success: false,
								error: "No transcripts found for this meeting. Ensure transcription was enabled during the meeting.",
							};
						}

						transcriptId = transcripts[0].id;
					}

					// Get transcript content
					const contentResponse = await fetch(
						`${betaUrl}/me/onlineMeetings/${meetingId}/transcripts/${transcriptId}/content?$format=text/vtt`,
						{
							headers: {
								...headers,
								Accept: "text/vtt",
							},
						},
					);

					if (!contentResponse.ok) {
						const errorText = await contentResponse.text();
						return {
							success: false,
							error: `Failed to get transcript: ${contentResponse.status} - ${errorText}`,
						};
					}

					const content = await contentResponse.text();
					return {
						success: true,
						output: "Retrieved transcript for meeting",
						data: {
							transcriptId,
							content,
							format: "vtt",
						},
					};
				}

				case "get_transcript_by_url": {
					const joinUrl = inputs.joinUrl as string;
					if (!joinUrl) {
						return {
							success: false,
							error: "joinUrl is required",
						};
					}

					const outputFormat = (inputs.format as string) || "text";

					// Query online meetings by join URL
					const onlineMeetingsResponse = await fetch(
						`${baseUrl}/me/onlineMeetings?$filter=JoinWebUrl eq '${encodeURIComponent(joinUrl)}'`,
						{ headers },
					);

					let meetingId: string | null = null;

					if (onlineMeetingsResponse.ok) {
						const onlineMeetingsData =
							(await onlineMeetingsResponse.json()) as {
								value: Array<{ id: string }>;
							};
						if (onlineMeetingsData.value.length > 0) {
							meetingId = onlineMeetingsData.value[0].id;
						}
					}

					if (!meetingId) {
						return {
							success: false,
							error: "Could not find online meeting for this join URL. Ensure you have access to this meeting.",
						};
					}

					// Get transcripts for this meeting
					const transcriptsResponse = await fetch(
						`${betaUrl}/me/onlineMeetings/${meetingId}/transcripts`,
						{ headers },
					);

					if (!transcriptsResponse.ok) {
						const errorText = await transcriptsResponse.text();
						return {
							success: false,
							error: `Failed to list transcripts: ${transcriptsResponse.status} - ${errorText}`,
						};
					}

					const transcriptsData =
						(await transcriptsResponse.json()) as {
							value: Array<{ id: string }>;
						};
					const transcripts = transcriptsData.value || [];

					if (transcripts.length === 0) {
						return {
							success: false,
							error: "No transcripts found for this meeting. Ensure transcription was enabled during the meeting.",
						};
					}

					// Get transcript content
					const transcriptId = transcripts[0].id;
					const formatParam =
						outputFormat === "vtt" ? "text/vtt" : "text/plain";

					const contentResponse = await fetch(
						`${betaUrl}/me/onlineMeetings/${meetingId}/transcripts/${transcriptId}/content?$format=${formatParam}`,
						{
							headers: {
								...headers,
								Accept: formatParam,
							},
						},
					);

					if (!contentResponse.ok) {
						const errorText = await contentResponse.text();
						return {
							success: false,
							error: `Failed to get transcript: ${contentResponse.status} - ${errorText}`,
						};
					}

					const content = await contentResponse.text();
					return {
						success: true,
						output: "Retrieved transcript for meeting",
						data: {
							meetingId,
							transcriptId,
							content,
							format: outputFormat,
						},
					};
				}

				// ========== Email (Outlook) ==========
				case "get_emails": {
					const folder = (inputs.folder as string) || "inbox";
					const params = new URLSearchParams();

					params.set("$top", String((inputs.limit as number) || 10));
					params.set(
						"$select",
						"id,subject,from,toRecipients,receivedDateTime,bodyPreview,hasAttachments,importance,isRead",
					);
					params.set("$orderby", "receivedDateTime desc");

					if (inputs.filter) {
						params.set("$filter", inputs.filter as string);
					}

					if (inputs.search) {
						params.set("$search", `"${inputs.search}"`);
					}

					const response = await fetch(
						`${baseUrl}/me/mailFolders/${folder}/messages?${params.toString()}`,
						{ headers },
					);

					if (!response.ok) {
						const errorText = await response.text();
						return {
							success: false,
							error: `Failed to get emails: ${response.status} - ${errorText}`,
						};
					}

					const data = await response.json();
					const emails = data.value || [];

					return {
						success: true,
						output: `Retrieved ${emails.length} emails from ${folder}`,
						data: {
							emails: emails.map((e: any) => ({
								id: e.id,
								subject: e.subject,
								from: e.from?.emailAddress?.address,
								fromName: e.from?.emailAddress?.name,
								receivedDateTime: e.receivedDateTime,
								bodyPreview: e.bodyPreview,
								hasAttachments: e.hasAttachments,
								importance: e.importance,
								isRead: e.isRead,
							})),
							totalCount: emails.length,
						},
					};
				}

				case "send_email": {
					const to = inputs.to as string[];
					const subject = inputs.subject as string;
					const body = inputs.body as string;

					if (!to || !subject || !body) {
						return {
							success: false,
							error: "to, subject, and body are required",
						};
					}

					const toRecipients = to.map((email) => ({
						emailAddress: { address: email },
					}));

					const ccRecipients = inputs.cc
						? (inputs.cc as string[]).map((email) => ({
								emailAddress: { address: email },
							}))
						: [];

					const message = {
						message: {
							subject,
							body: {
								contentType: "HTML",
								content: body,
							},
							toRecipients,
							ccRecipients,
							importance:
								(inputs.importance as string) || "normal",
						},
						saveToSentItems: true,
					};

					const response = await fetch(`${baseUrl}/me/sendMail`, {
						method: "POST",
						headers,
						body: JSON.stringify(message),
					});

					if (!response.ok) {
						const errorText = await response.text();
						return {
							success: false,
							error: `Failed to send email: ${response.status} - ${errorText}`,
						};
					}

					return {
						success: true,
						output: `Email sent to ${to.join(", ")}`,
						data: { recipients: to, subject },
					};
				}

				// ========== Calendar ==========
				case "get_calendar_events": {
					const now = new Date();
					const startDateTime =
						(inputs.startDateTime as string) || now.toISOString();
					const endDateTime =
						(inputs.endDateTime as string) ||
						new Date(
							now.getTime() + 7 * 24 * 60 * 60 * 1000,
						).toISOString();

					const params = new URLSearchParams();
					params.set("startDateTime", startDateTime);
					params.set("endDateTime", endDateTime);
					params.set("$top", String((inputs.limit as number) || 10));
					params.set(
						"$select",
						"id,subject,start,end,location,organizer,attendees,isOnlineMeeting,onlineMeeting,bodyPreview",
					);
					params.set("$orderby", "start/dateTime");

					const response = await fetch(
						`${baseUrl}/me/calendarView?${params.toString()}`,
						{ headers },
					);

					if (!response.ok) {
						const errorText = await response.text();
						return {
							success: false,
							error: `Failed to get calendar events: ${response.status} - ${errorText}`,
						};
					}

					const data = await response.json();
					const events = data.value || [];

					return {
						success: true,
						output: `Found ${events.length} calendar events`,
						data: {
							events: events.map((e: any) => ({
								id: e.id,
								subject: e.subject,
								start: e.start?.dateTime,
								end: e.end?.dateTime,
								location: e.location?.displayName,
								isOnlineMeeting: e.isOnlineMeeting,
								joinUrl: e.onlineMeeting?.joinUrl,
								bodyPreview: e.bodyPreview,
							})),
							totalCount: events.length,
						},
					};
				}

				case "create_calendar_event": {
					const subject = inputs.subject as string;
					const start = inputs.start as string;
					const end = inputs.end as string;

					if (!subject || !start || !end) {
						return {
							success: false,
							error: "subject, start, and end are required",
						};
					}

					const event: Record<string, unknown> = {
						subject,
						start: { dateTime: start, timeZone: "UTC" },
						end: { dateTime: end, timeZone: "UTC" },
					};

					if (inputs.body) {
						event.body = {
							contentType: "HTML",
							content: inputs.body as string,
						};
					}

					if (inputs.location) {
						event.location = {
							displayName: inputs.location as string,
						};
					}

					if (inputs.attendees) {
						event.attendees = (inputs.attendees as string[]).map(
							(email) => ({
								emailAddress: { address: email },
								type: "required",
							}),
						);
					}

					if (inputs.isOnlineMeeting) {
						event.isOnlineMeeting = true;
						event.onlineMeetingProvider = "teamsForBusiness";
					}

					const response = await fetch(`${baseUrl}/me/events`, {
						method: "POST",
						headers,
						body: JSON.stringify(event),
					});

					if (!response.ok) {
						const errorText = await response.text();
						return {
							success: false,
							error: `Failed to create event: ${response.status} - ${errorText}`,
						};
					}

					const createdEvent = await response.json();
					return {
						success: true,
						output: `Created calendar event: ${subject}`,
						data: {
							id: createdEvent.id,
							subject: createdEvent.subject,
							start: createdEvent.start?.dateTime,
							end: createdEvent.end?.dateTime,
							webLink: createdEvent.webLink,
							joinUrl: createdEvent.onlineMeeting?.joinUrl,
						},
					};
				}

				// ========== Files (OneDrive/SharePoint) ==========
				case "search_files": {
					const query = inputs.query as string;
					if (!query) {
						return { success: false, error: "query is required" };
					}

					const searchRequest = {
						requests: [
							{
								entityTypes: ["driveItem"],
								query: { queryString: query },
								from: 0,
								size: (inputs.limit as number) || 10,
							},
						],
					};

					const response = await fetch(`${baseUrl}/search/query`, {
						method: "POST",
						headers,
						body: JSON.stringify(searchRequest),
					});

					if (!response.ok) {
						const errorText = await response.text();
						return {
							success: false,
							error: `Search failed: ${response.status} - ${errorText}`,
						};
					}

					const searchResult = await response.json();
					const hits =
						searchResult.value?.[0]?.hitsContainers?.[0]?.hits ||
						[];

					return {
						success: true,
						output: `Found ${hits.length} files matching "${query}"`,
						data: {
							results: hits.map((hit: any) => ({
								id: hit.resource?.id,
								name: hit.resource?.name,
								webUrl: hit.resource?.webUrl,
								size: hit.resource?.size,
								lastModified:
									hit.resource?.lastModifiedDateTime,
							})),
							totalCount:
								searchResult.value?.[0]?.hitsContainers?.[0]
									?.total || 0,
						},
					};
				}

				case "get_file_content": {
					let url: string;

					if (inputs.fileId) {
						url = `${baseUrl}/me/drive/items/${inputs.fileId}/content`;
					} else if (inputs.filePath) {
						const encodedPath = encodeURIComponent(
							inputs.filePath as string,
						).replace(/%2F/g, "/");
						url = `${baseUrl}/me/drive/root:${encodedPath}:/content`;
					} else {
						return {
							success: false,
							error: "Either fileId or filePath is required",
						};
					}

					const response = await fetch(url, {
						headers: { Authorization: `Bearer ${accessToken}` },
						redirect: "follow",
					});

					if (!response.ok) {
						const errorText = await response.text();
						return {
							success: false,
							error: `Failed to get file: ${response.status} - ${errorText}`,
						};
					}

					const contentType =
						response.headers.get("content-type") || "";

					if (
						contentType.includes("text") ||
						contentType.includes("json") ||
						contentType.includes("xml")
					) {
						const content = await response.text();
						return {
							success: true,
							output: "Retrieved file content",
							data: { content, contentType },
						};
					}

					// For binary files, return as base64
					const buffer = await response.arrayBuffer();
					return {
						success: true,
						output: "Retrieved binary file",
						data: {
							content: Buffer.from(buffer).toString("base64"),
							contentType,
							encoding: "base64",
						},
					};
				}

				// ========== User Profile ==========
				case "get_profile": {
					const response = await fetch(
						`${baseUrl}/me?$select=id,displayName,mail,userPrincipalName,jobTitle,department,officeLocation,mobilePhone`,
						{ headers },
					);

					if (!response.ok) {
						const errorText = await response.text();
						return {
							success: false,
							error: `Failed to get profile: ${response.status} - ${errorText}`,
						};
					}

					const profile = await response.json();
					return {
						success: true,
						output: `Retrieved profile for ${profile.displayName}`,
						data: profile,
					};
				}

				default:
					return {
						success: false,
						error: `Unsupported Microsoft Graph operation: ${operation}`,
					};
			}
		} catch (error) {
			return {
				success: false,
				error:
					error instanceof Error
						? error.message
						: "Microsoft Graph API error",
			};
		}
	}
}
