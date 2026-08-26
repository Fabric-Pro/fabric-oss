/**
 * Trigger System Types
 *
 * Types for the agent trigger system that allows agents to be invoked via:
 * - Webhooks (HTTP endpoints)
 * - Schedules (cron/interval)
 * - Slack mentions (@agent)
 * - Email (sent to agent@fabric.ai)
 * - API calls
 */

// =============================================================================
// Trigger Types
// =============================================================================

export type TriggerType =
	| "WEBHOOK"
	| "SCHEDULE"
	| "SLACK_MENTION"
	| "EMAIL"
	| "API"
	| "MANUAL"
	| "LIFECYCLE_EVENT";

export type TriggerStatus = "ACTIVE" | "PAUSED" | "ERROR" | "DELETED";

// =============================================================================
// Trigger Configuration
// =============================================================================

export interface TriggerConfig {
	id: string;

	/** Agent to invoke */
	agentId: string;
	agentName: string;

	/** Trigger type */
	type: TriggerType;

	/** Human-readable name */
	name: string;
	description?: string;

	/** Type-specific configuration */
	config: TriggerTypeConfig;

	/** Input transformation template */
	inputTemplate?: string;

	/** Output handling */
	outputConfig?: TriggerOutputConfig;

	/** Status */
	status: TriggerStatus;
	lastTriggeredAt?: Date;
	lastError?: string;

	/** Ownership */
	userId: string;
	organizationId?: string;

	createdAt: Date;
	updatedAt: Date;
}

export type TriggerTypeConfig =
	| WebhookTriggerConfig
	| ScheduleTriggerConfig
	| SlackMentionTriggerConfig
	| EmailTriggerConfig
	| ApiTriggerConfig
	| LifecycleEventTriggerConfig;

export interface LifecycleEventTriggerConfig {
	type: "LIFECYCLE_EVENT";
	resource: "story" | "task" | "comment" | "coding_run";
	event: "created" | "updated" | "status_changed" | "completed";
	conditions?: Record<string, unknown>;
}

// =============================================================================
// Webhook Trigger
// =============================================================================

export interface WebhookTriggerConfig {
	type: "WEBHOOK";

	/** Unique webhook endpoint path */
	endpointPath: string;

	/** Secret for HMAC signature verification */
	secret: string;

	/** Allowed HTTP methods */
	methods: Array<"GET" | "POST" | "PUT" | "PATCH">;

	/** IP allowlist (optional) */
	allowedIps?: string[];

	/** Rate limit (requests per minute) */
	rateLimit?: number;

	/** JSON path to extract message from payload */
	messageJsonPath?: string;

	/** Custom headers to require */
	requiredHeaders?: Record<string, string>;
}

// =============================================================================
// Schedule Trigger
// =============================================================================

export interface ScheduleTriggerConfig {
	type: "SCHEDULE";

	/** Schedule type */
	scheduleType: "cron" | "interval" | "natural_language";

	/** Cron expression (if scheduleType is 'cron') */
	cronExpression?: string;

	/** Interval in minutes (if scheduleType is 'interval') */
	intervalMinutes?: number;

	/** Natural language schedule (parsed to cron) */
	naturalLanguage?: string;

	/** Parsed cron from natural language */
	parsedCron?: string;

	/** Timezone */
	timezone: string;

	/** Fixed input to send on each trigger */
	fixedInput?: string;

	/** Max concurrent executions */
	maxConcurrent?: number;
}

// =============================================================================
// Slack Mention Trigger
// =============================================================================

export interface SlackMentionTriggerConfig {
	type: "SLACK_MENTION";

	/** Slack workspace ID */
	workspaceId: string;

	/** Bot user ID in Slack */
	botUserId: string;

	/** Channels to listen in (empty = all) */
	channels?: string[];

	/** Excluded channels */
	excludeChannels?: string[];

	/** Require direct mention vs thread mention */
	requireDirectMention: boolean;

	/** Include thread context */
	includeThreadContext: boolean;

	/** Response mode */
	responseMode: "thread" | "channel" | "dm";
}

// =============================================================================
// Email Trigger
// =============================================================================

export interface EmailTriggerConfig {
	type: "EMAIL";

	/** Unique email address for this trigger */
	emailAddress: string;

	/** Allowed sender domains (empty = all) */
	allowedDomains?: string[];

	/** Blocked sender addresses */
	blockedAddresses?: string[];

	/** Include attachments */
	includeAttachments: boolean;

	/** Max attachment size (bytes) */
	maxAttachmentSize?: number;

	/** Response behavior */
	autoReply: boolean;
}

// =============================================================================
// API Trigger
// =============================================================================

export interface ApiTriggerConfig {
	type: "API";

	/** API key for authentication */
	apiKey: string;

	/** Rate limit (requests per minute) */
	rateLimit: number;

	/** Allowed scopes */
	scopes: string[];
}

// =============================================================================
// Output Configuration
// =============================================================================

export interface TriggerOutputConfig {
	/** Send response back to trigger source */
	respondToSource: boolean;

	/** Webhook URL to send results */
	webhookUrl?: string;

	/** Email to send results */
	emailTo?: string[];

	/** Slack channel to post results */
	slackChannel?: string;

	/** Store in database */
	storeResults: boolean;

	/** Output format transformation */
	outputTemplate?: string;
}

// =============================================================================
// Trigger Event
// =============================================================================

export interface TriggerEvent {
	id: string;
	triggerId: string;
	triggerType: TriggerType;

	/** Raw input from trigger source */
	rawInput: unknown;

	/** Parsed message for agent */
	message: string;

	/** Context from trigger source */
	context: TriggerContext;

	/** Metadata */
	receivedAt: Date;
	processedAt?: Date;
	status: "pending" | "processing" | "completed" | "failed";
	error?: string;

	/** Agent execution result */
	agentExecutionId?: string;
	agentResponse?: string;
}

export interface TriggerContext {
	/** Source identifier */
	sourceId: string;
	sourceName?: string;

	/** User who triggered (if applicable) */
	triggeredBy?: {
		id: string;
		name: string;
		email?: string;
	};

	/** Additional context */
	metadata: Record<string, unknown>;
}

// =============================================================================
// Workflow Types
// =============================================================================

export interface TriggerWorkflowInput {
	triggerId: string;
	event: TriggerEvent;
	userId: string;
	organizationId?: string;
}

export interface TriggerWorkflowOutput {
	eventId: string;
	triggerId: string;
	success: boolean;
	agentExecutionId?: string;
	response?: string;
	error?: string;
	durationMs: number;
}

export interface ScheduledTriggerInput {
	triggerId: string;
	scheduleConfig: ScheduleTriggerConfig;
	userId: string;
	organizationId?: string;
}

// =============================================================================
// Natural Language Schedule Parsing
// =============================================================================

export interface ParsedSchedule {
	cronExpression: string;
	timezone: string;
	description: string;
	nextOccurrences: Date[];
}

export const SCHEDULE_EXAMPLES = [
	{ input: "every day at 9am", cron: "0 9 * * *" },
	{ input: "every monday at 10:30", cron: "30 10 * * 1" },
	{ input: "every hour", cron: "0 * * * *" },
	{ input: "every 15 minutes", cron: "*/15 * * * *" },
	{ input: "first of every month at noon", cron: "0 12 1 * *" },
	{ input: "weekdays at 8am", cron: "0 8 * * 1-5" },
	{ input: "every sunday at 6pm", cron: "0 18 * * 0" },
];

// =============================================================================
// Helpers
// =============================================================================

export function createTriggerEvent(
	triggerId: string,
	triggerType: TriggerType,
	rawInput: unknown,
	message: string,
	context: TriggerContext,
): TriggerEvent {
	return {
		id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
		triggerId,
		triggerType,
		rawInput,
		message,
		context,
		receivedAt: new Date(),
		status: "pending",
	};
}

export function generateWebhookPath(): string {
	return `hook_${Math.random().toString(36).slice(2, 15)}`;
}

export function generateWebhookSecret(): string {
	return `whsec_${Math.random().toString(36).slice(2, 15)}${Math.random().toString(36).slice(2, 15)}`;
}

export function generateApiKey(): string {
	return `fab_${Math.random().toString(36).slice(2, 15)}${Math.random().toString(36).slice(2, 15)}`;
}

export function generateEmailAddress(agentName: string): string {
	const slug = agentName.toLowerCase().replace(/[^a-z0-9]/g, "-");
	const suffix = Math.random().toString(36).slice(2, 8);
	return `${slug}-${suffix}@agents.fabric.ai`;
}
