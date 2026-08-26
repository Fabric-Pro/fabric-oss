/**
 * Typed Artifact System
 *
 * Structured data flow between steps using typed artifacts.
 * Replaces text summaries with semantically meaningful data objects.
 *
 * Part of Phase 4: Rich Context Flow
 */

// =============================================================================
// Base Artifact Type
// =============================================================================

/**
 * Base interface for all artifacts.
 */
export interface BaseArtifact {
	/** Unique artifact ID */
	id: string;
	/** Artifact type discriminator */
	type: ArtifactType;
	/** Step ID that created this artifact */
	createdBy: string;
	/** When the artifact was created */
	createdAt: Date;
	/** Additional metadata */
	metadata: Record<string, unknown>;
	/** Human-readable name */
	name?: string;
	/** Description of the artifact */
	description?: string;
	/** Tags for categorization */
	tags?: string[];
}

export type ArtifactType =
	| "code"
	| "document"
	| "data"
	| "api_response"
	| "browser_state"
	| "file"
	| "summary"
	| "tool_result"
	| "plan"
	| "error";

// =============================================================================
// Specialized Artifact Types
// =============================================================================

/**
 * Code artifact - represents code that was written or executed.
 */
export interface CodeArtifact extends BaseArtifact {
	type: "code";
	/** Programming language */
	language: string;
	/** The code content */
	content: string;
	/** File path if saved to file */
	filePath?: string;
	/** Execution result if the code was run */
	executionResult?: {
		stdout: string;
		stderr: string;
		exitCode: number;
		durationMs: number;
	};
	/** Dependencies or imports used */
	dependencies?: string[];
	/** Whether the code was validated/linted */
	validated?: boolean;
}

/**
 * Document artifact - represents generated or retrieved documents.
 */
export interface DocumentArtifact extends BaseArtifact {
	type: "document";
	/** Document format */
	format: "markdown" | "html" | "pdf" | "docx" | "text" | "json";
	/** Document content */
	content: string;
	/** Document title */
	title?: string;
	/** Section structure */
	sections?: DocumentSection[];
	/** Word count */
	wordCount?: number;
	/** Source documents used (if compiled from multiple sources) */
	sources?: string[];
}

export interface DocumentSection {
	id: string;
	title: string;
	level: number;
	content: string;
	subsections?: DocumentSection[];
}

/**
 * Data artifact - represents structured data (JSON, CSV, etc.).
 */
export interface DataArtifact extends BaseArtifact {
	type: "data";
	/** Data format */
	format: "json" | "csv" | "table" | "array" | "object";
	/** JSON schema of the data */
	schema?: Record<string, unknown>;
	/** The actual data */
	data: unknown;
	/** Number of records (if array) */
	recordCount?: number;
	/** Column names (if tabular) */
	columns?: string[];
}

/**
 * API response artifact - represents responses from API calls.
 */
export interface ApiResponseArtifact extends BaseArtifact {
	type: "api_response";
	/** API endpoint called */
	endpoint: string;
	/** HTTP method used */
	method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	/** HTTP status code */
	statusCode: number;
	/** Response headers */
	headers: Record<string, string>;
	/** Response body */
	body: unknown;
	/** Request that generated this response */
	request?: {
		url: string;
		method: string;
		headers?: Record<string, string>;
		body?: unknown;
	};
	/** Response time in ms */
	responseTimeMs: number;
}

/**
 * Browser state artifact - represents browser state from automation.
 */
export interface BrowserStateArtifact extends BaseArtifact {
	type: "browser_state";
	/** Current URL */
	url: string;
	/** Page title */
	title?: string;
	/** Screenshot (base64 encoded) */
	screenshot?: string;
	/** DOM snapshot (simplified) */
	domSnapshot?: string;
	/** Page text content */
	textContent?: string;
	/** Cookies */
	cookies?: Array<{
		name: string;
		value: string;
		domain: string;
	}>;
	/** Local storage entries */
	localStorage?: Record<string, string>;
	/** Actions performed to reach this state */
	actionHistory?: BrowserAction[];
}

export interface BrowserAction {
	type: "navigate" | "click" | "type" | "scroll" | "wait" | "screenshot";
	target?: string;
	value?: string;
	timestamp: Date;
}

/**
 * File artifact - represents a file that was created or uploaded.
 */
export interface FileArtifact extends BaseArtifact {
	type: "file";
	/** File name */
	fileName: string;
	/** File path */
	filePath: string;
	/** MIME type */
	mimeType: string;
	/** File size in bytes */
	sizeBytes: number;
	/** File content (for small text files) */
	content?: string;
	/** URL if stored remotely */
	url?: string;
	/** Checksum for verification */
	checksum?: string;
}

/**
 * Summary artifact - represents a summarized view of other artifacts.
 */
export interface SummaryArtifact extends BaseArtifact {
	type: "summary";
	/** Summary text */
	summary: string;
	/** Key points extracted */
	keyPoints: string[];
	/** Source artifact IDs */
	sourceArtifacts: string[];
	/** Confidence score (0-1) */
	confidence: number;
}

/**
 * Tool result artifact - represents the result of an MCP tool call.
 */
export interface ToolResultArtifact extends BaseArtifact {
	type: "tool_result";
	/** Tool name */
	toolName: string;
	/** Server name */
	serverName: string;
	/** Arguments passed to the tool */
	args: Record<string, unknown>;
	/** Result from the tool */
	result: unknown;
	/** Whether the call was successful */
	success: boolean;
	/** Error message if failed */
	errorMessage?: string;
	/** Duration in ms */
	durationMs: number;
	/** Whether result was cached */
	cached?: boolean;
}

/**
 * Plan artifact - represents a task plan.
 */
export interface PlanArtifact extends BaseArtifact {
	type: "plan";
	/** Plan description */
	planDescription: string;
	/** Steps in the plan */
	steps: Array<{
		id: string;
		description: string;
		status: string;
		executor?: string;
	}>;
	/** Strategy used */
	strategy: string;
	/** Risk level */
	riskLevel: string;
}

/**
 * Error artifact - represents an error that occurred.
 */
export interface ErrorArtifact extends BaseArtifact {
	type: "error";
	/** Error message */
	errorMessage: string;
	/** Error code */
	errorCode?: string;
	/** Stack trace */
	stackTrace?: string;
	/** Step that caused the error */
	failedStepId?: string;
	/** Recovery attempt made */
	recoveryAttempt?: string;
	/** Whether recovery was successful */
	recovered: boolean;
}

// =============================================================================
// Union Type
// =============================================================================

export type Artifact =
	| CodeArtifact
	| DocumentArtifact
	| DataArtifact
	| ApiResponseArtifact
	| BrowserStateArtifact
	| FileArtifact
	| SummaryArtifact
	| ToolResultArtifact
	| PlanArtifact
	| ErrorArtifact;

// =============================================================================
// Step I/O Contracts
// =============================================================================

/**
 * Defines what a step requires and produces.
 */
export interface StepIOContract {
	stepId: string;

	/** What this step needs */
	requires: StepInput[];

	/** What this step produces */
	produces: StepOutput[];

	/** Input validation schema */
	inputSchema?: Record<string, unknown>;

	/** Output validation schema */
	outputSchema?: Record<string, unknown>;
}

export interface StepInput {
	/** Input name */
	name: string;
	/** Expected type */
	type: ArtifactType | "string" | "number" | "boolean" | "any";
	/** Reference to artifact type */
	artifactType?: ArtifactType;
	/** Source step ID or "input" for workflow input */
	source?: string;
	/** Whether this input is required */
	required: boolean;
	/** Default value if not provided */
	defaultValue?: unknown;
	/** Description */
	description?: string;
}

export interface StepOutput {
	/** Output name */
	name: string;
	/** Output type */
	type: ArtifactType | "string" | "number" | "boolean" | "any";
	/** Reference to artifact type */
	artifactType?: ArtifactType;
	/** Description */
	description: string;
}

// =============================================================================
// Artifact Store Interface
// =============================================================================

/**
 * Interface for storing and retrieving artifacts.
 */
export interface ArtifactStore {
	/** Store an artifact */
	store(artifact: Artifact): Promise<string>;

	/** Retrieve an artifact by ID */
	get(id: string): Promise<Artifact | null>;

	/** Find artifacts by type */
	findByType(type: ArtifactType): Promise<Artifact[]>;

	/** Find artifacts created by a step */
	findByStep(stepId: string): Promise<Artifact[]>;

	/** Find artifacts with specific tags */
	findByTags(tags: string[]): Promise<Artifact[]>;

	/** Delete an artifact */
	delete(id: string): Promise<boolean>;

	/** List all artifact IDs */
	listIds(): Promise<string[]>;

	/** Clear all artifacts */
	clear(): Promise<void>;
}

// =============================================================================
// Type Guards
// =============================================================================

export function isCodeArtifact(artifact: Artifact): artifact is CodeArtifact {
	return artifact.type === "code";
}

export function isDocumentArtifact(
	artifact: Artifact,
): artifact is DocumentArtifact {
	return artifact.type === "document";
}

export function isDataArtifact(artifact: Artifact): artifact is DataArtifact {
	return artifact.type === "data";
}

export function isApiResponseArtifact(
	artifact: Artifact,
): artifact is ApiResponseArtifact {
	return artifact.type === "api_response";
}

export function isBrowserStateArtifact(
	artifact: Artifact,
): artifact is BrowserStateArtifact {
	return artifact.type === "browser_state";
}

export function isFileArtifact(artifact: Artifact): artifact is FileArtifact {
	return artifact.type === "file";
}

export function isSummaryArtifact(
	artifact: Artifact,
): artifact is SummaryArtifact {
	return artifact.type === "summary";
}

export function isToolResultArtifact(
	artifact: Artifact,
): artifact is ToolResultArtifact {
	return artifact.type === "tool_result";
}

export function isPlanArtifact(artifact: Artifact): artifact is PlanArtifact {
	return artifact.type === "plan";
}

export function isErrorArtifact(artifact: Artifact): artifact is ErrorArtifact {
	return artifact.type === "error";
}
