/**
 * Shared types for @fabricorg/sdk
 */

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/** Explicit personal context — queries organizationId: null */
export interface PersonalContext {
	type: "personal";
}

/** Explicit org context — queries by org slug or ID */
export interface OrgContext {
	type: "org";
	/** Organization slug (e.g. "acme") or ID */
	slug: string;
}

export type FabricContext = PersonalContext | OrgContext;

// ---------------------------------------------------------------------------
// API response envelope
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export interface FabricUser {
	id: string;
	name: string | null;
	email: string;
	role: string;
	createdAt: string;
}

export interface FabricOrg {
	id: string;
	name: string;
	slug: string;
	logo: string | null;
	role: string;
	joinedAt: string;
}

export interface FabricApiKey {
	id: string;
	name: string;
	keyPrefix: string;
	scopes: string[];
	expiresAt: string | null;
	lastUsedAt: string | null;
	usageCount: number;
	isActive: boolean;
	createdAt: string;
}

export interface FabricApiKeyCreated extends FabricApiKey {
	/** Raw key — only present on creation, never retrievable again */
	rawKey: string;
}

export interface WhoamiResult {
	user: FabricUser;
	keyType: "personal" | "organization";
	keyPrefix: string;
	scopes: string[];
	organizationContext?: string;
	orgs: FabricOrg[];
}

// ---- Projects ----
export interface FabricProject {
	id: string;
	name: string;
	description: string | null;
	status: "DRAFT" | "ACTIVE" | "COMPLETED" | "ARCHIVED";
	color: string | null;
	icon: string | null;
	userId: string;
	organizationId: string | null;
	repositoryUrl: string | null;
	createdAt: string;
	updatedAt: string;
}

// ---- Documents ----
export interface FabricDocumentSummary {
	id: string;
	projectId: string;
	type:
		| "GENERAL"
		| "PRD"
		| "PROPOSAL"
		| "BUSINESS_CASE"
		| "ARCHITECTURE"
		| "TECHNICAL_SPEC"
		| "USER_STORY"
		| "API_SPEC";
	title: string;
	status:
		| "DRAFT"
		| "GENERATING"
		| "IN_PROGRESS"
		| "REVIEW"
		| "COMPLETE"
		| "FAILED";
	version: number;
	wordCount: number | null;
	createdAt: string;
	updatedAt: string;
}

export interface FabricDocument extends FabricDocumentSummary {
	content: string;
}

// ---- Features ----
export interface FabricFeature {
	id: string;
	identifier: string; // "F-001"
	title: string;
	description: string | null;
	acceptanceCriteria: string | null;
	priority: "P0_CRITICAL" | "P1_HIGH" | "P2_MEDIUM" | "P3_LOW";
	projectId: string;
	assigneeId: string | null;
	version: number;
	order: number;
	createdAt: string;
	updatedAt: string;
}

// ---- Workflows ----
export interface FabricWorkflow {
	id: string;
	name: string;
	description: string | null;
	status: "DRAFT" | "ACTIVE" | "PAUSED" | "ARCHIVED";
	triggerType: "MANUAL" | "SCHEDULED" | "WEBHOOK" | "EVENT";
	version: number;
	userId: string;
	organizationId: string | null;
	projectId: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface FabricExecution {
	id: string;
	workflowId: string;
	status: string;
	triggerType: string;
	startedAt: string | null;
	completedAt: string | null;
	error: string | null;
	output: unknown;
	createdAt: string;
}

// ---- Prompts ----
export interface FabricPrompt {
	id: string;
	key: string;
	name: string;
	description: string | null;
	scope: "SYSTEM" | "ORG" | "USER";
	category: string | null;
	tags: string[];
	format: string;
	usageCount: number;
	createdAt: string;
	updatedAt: string;
	versions?: Array<{ id: string; version: number; content: string }>;
}

// ---- Agents ----
export interface FabricAgent {
	id: string;
	agentId: string;
	name: string;
	displayName: string;
	description: string | null;
	framework: string;
	status: "ACTIVE" | "INACTIVE" | "DEPRECATED";
	deploymentUrl: string | null;
	userId: string;
	organizationId: string | null;
	createdAt: string;
	updatedAt: string;
}

// ---- Skills ----
export interface FabricSkill {
	id: string;
	slug: string;
	name: string;
	description: string;
	content: string;
	category: string | null;
	tags: string[];
	scope: string;
	isPublished: boolean;
	useCount: number;
	version: number;
	createdAt: string;
	updatedAt: string;
}

// ---- List options ----
export interface ListOptions {
	org?: string;
	personal?: boolean;
	limit?: number;
	offset?: number;
	search?: string;
}

// ---------------------------------------------------------------------------
// Client options
// ---------------------------------------------------------------------------

export interface FabricRetryOptions {
	/** Max retries on transient failures (network errors, 429, 5xx). Default 2 (= 3 total attempts). 0 disables retries. */
	maxRetries?: number;
	/** Initial backoff in ms. Default 250 */
	initialDelayMs?: number;
	/** Backoff multiplier between attempts. Default 2 */
	multiplier?: number;
	/** Cap on any single backoff delay in ms. Default 5000 */
	maxDelayMs?: number;
}

/**
 * Telemetry event emitted by the SDK for every request lifecycle stage.
 * Bodies, headers, and the API key are never included for safety.
 */
export interface FabricTelemetryEvent {
	kind: "request" | "response" | "error" | "retry";
	method: string;
	path: string;
	attempt: number;
	status?: number;
	durationMs?: number;
	error?: { message: string; code?: string };
}

export interface FabricClientOptions {
	/** API key (fab_* or org_*). Falls back to FABRIC_API_KEY env var. */
	apiKey?: string;
	/** Base URL of the Fabric instance. Defaults to https://app.fabricai.com (override via FABRIC_BASE_URL) */
	baseUrl?: string;
	/** Default org slug applied to every request unless overridden per-call. Falls back to FABRIC_ORG. Mutually exclusive with `personal`. */
	org?: string;
	/** Default personal-context flag applied to every request unless overridden per-call. Falls back to FABRIC_PERSONAL=1. Mutually exclusive with `org`. */
	personal?: boolean;
	/** Default project ID applied where the resource accepts one. Falls back to FABRIC_PROJECT. */
	project?: string;
	/** Custom fetch implementation (testing, proxies, polyfills). Defaults to global fetch. */
	fetch?: typeof fetch;
	/** Per-request timeout in ms. Default 60_000. */
	timeoutMs?: number;
	/** Retry policy for transient failures (network errors, HTTP 408/425/429/5xx). */
	retry?: FabricRetryOptions;
	/** Telemetry hook invoked on every request, response, retry, and error. */
	onEvent?: (event: FabricTelemetryEvent) => void;
}

// ---- MCP ----
export interface FabricMcpServer {
	id: string;
	key: string;
	name: string;
	description: string | null;
	transport: string;
	defaultUrl: string | null;
	docsUrl: string | null;
	author: string | null;
	category: string | null;
	tags: string[];
	isSystemProvided: boolean;
	createdAt: string;
}

export interface FabricMcpConfig {
	id: string;
	mcpServerId: string;
	serverKey: string | null;
	serverName: string | null;
	displayName: string | null;
	transport: string | null;
	authType: string;
	enabled: boolean;
	status: string;
	lastHealthCheckAt: string | null;
	createdAt: string;
}

export interface FabricMcpConfigDetail extends FabricMcpConfig {
	baseUrl: string | null;
}

// ---- Tasks (sub-items under features) ----
export interface FabricTask {
	id: string;
	identifier: string;
	title: string;
	description: string | null;
	isCompleted: boolean;
	estimatedHours: number | null;
	agentCompletedAt: string | null;
	order: number;
	storyId: string;
	createdAt: string;
}

// ---- Frames ----
export interface FabricFrame {
	id: string;
	title: string;
	description: string | null;
	kind: string | null;
	fileType: string;
	status: string;
	isPublic: boolean;
	shareToken: string | null;
	userId: string;
	organizationId: string | null;
	createdAt: string;
	updatedAt: string;
}

// ---- Workspaces ----
export interface FabricWorkspace {
	id: string;
	name: string;
	description: string | null;
	type: string;
	status: "ACTIVE" | "ARCHIVED";
	documentCount: number;
	userId: string;
	organizationId: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface FabricWorkspaceDetail extends FabricWorkspace {
	conversationCount: number;
}

// ---- Chats ----
export interface FabricChat {
	id: string;
	title: string | null;
	userId: string;
	organizationId: string | null;
	createdAt: string;
	updatedAt: string;
}

// ---- Reports ----
export interface FabricReportTemplate {
	id: string;
	name: string;
	description: string | null;
	scope: string;
	templateType: string;
	category: string | null;
	tags: string[];
	isPublic: boolean;
	usageCount: number;
	createdAt: string;
	updatedAt: string;
}

export interface FabricReportExecution {
	id: string;
	templateId: string | null;
	status: string;
	userId: string;
	organizationId: string | null;
	startedAt: string | null;
	completedAt: string | null;
	error: string | null;
	createdAt: string;
}

// ---- Agent execution ----
export interface FabricAgentExecution {
	taskId: string;
	workflowId: string;
	runId: string | null;
	status: string;
	warning?: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class FabricError extends Error {
	constructor(
		message: string,
		public readonly status: number,
		public readonly code?: string,
	) {
		super(message);
		this.name = "FabricError";
	}
}

export class FabricAuthError extends FabricError {
	constructor(message = "Authentication failed") {
		super(message, 401, "AUTH_FAILED");
		this.name = "FabricAuthError";
	}
}

export class FabricNotFoundError extends FabricError {
	constructor(resource = "Resource") {
		super(`${resource} not found`, 404, "NOT_FOUND");
		this.name = "FabricNotFoundError";
	}
}

export class FabricForbiddenError extends FabricError {
	constructor(scope?: string) {
		super(
			scope ? `Missing required scope: ${scope}` : "Forbidden",
			403,
			"FORBIDDEN",
		);
		this.name = "FabricForbiddenError";
	}
}
