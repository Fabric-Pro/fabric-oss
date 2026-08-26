/**
 * Artifact Store Implementation
 *
 * In-memory artifact store for workflow execution.
 * Provides storage, retrieval, and transformation of typed artifacts.
 *
 * Part of Phase 4: Rich Context Flow
 */

import { randomUUID } from "node:crypto";
import type {
	ApiResponseArtifact,
	Artifact,
	ArtifactStore,
	ArtifactType,
	BrowserStateArtifact,
	CodeArtifact,
	DataArtifact,
	DocumentArtifact,
	ErrorArtifact,
	FileArtifact,
	SummaryArtifact,
	ToolResultArtifact,
} from "./types";

// =============================================================================
// In-Memory Artifact Store
// =============================================================================

/**
 * In-memory implementation of ArtifactStore.
 * Designed for use within a single workflow execution.
 */
export class InMemoryArtifactStore implements ArtifactStore {
	private artifacts: Map<string, Artifact> = new Map();
	private typeIndex: Map<ArtifactType, Set<string>> = new Map();
	private stepIndex: Map<string, Set<string>> = new Map();
	private tagIndex: Map<string, Set<string>> = new Map();

	async store(artifact: Artifact): Promise<string> {
		// Generate ID if not present
		if (!artifact.id) {
			artifact.id = `artifact-${randomUUID()}`;
		}

		// Store artifact
		this.artifacts.set(artifact.id, artifact);

		// Update type index
		if (!this.typeIndex.has(artifact.type)) {
			this.typeIndex.set(artifact.type, new Set());
		}
		this.typeIndex.get(artifact.type)?.add(artifact.id);

		// Update step index
		if (!this.stepIndex.has(artifact.createdBy)) {
			this.stepIndex.set(artifact.createdBy, new Set());
		}
		this.stepIndex.get(artifact.createdBy)?.add(artifact.id);

		// Update tag index
		if (artifact.tags) {
			for (const tag of artifact.tags) {
				if (!this.tagIndex.has(tag)) {
					this.tagIndex.set(tag, new Set());
				}
				this.tagIndex.get(tag)?.add(artifact.id);
			}
		}

		return artifact.id;
	}

	async get(id: string): Promise<Artifact | null> {
		return this.artifacts.get(id) || null;
	}

	async findByType(type: ArtifactType): Promise<Artifact[]> {
		const ids = this.typeIndex.get(type);
		if (!ids) {
			return [];
		}
		return Array.from(ids)
			.map((id) => this.artifacts.get(id))
			.filter((a): a is Artifact => !!a);
	}

	async findByStep(stepId: string): Promise<Artifact[]> {
		const ids = this.stepIndex.get(stepId);
		if (!ids) {
			return [];
		}
		return Array.from(ids)
			.map((id) => this.artifacts.get(id))
			.filter((a): a is Artifact => !!a);
	}

	async findByTags(tags: string[]): Promise<Artifact[]> {
		if (tags.length === 0) {
			return [];
		}

		// Find artifacts that have ALL specified tags (AND logic)
		const matchingIds = new Set<string>();
		let first = true;

		for (const tag of tags) {
			const tagIds = this.tagIndex.get(tag);
			if (!tagIds) {
				return []; // Tag not found, no matches
			}

			if (first) {
				tagIds.forEach((id) => {
					matchingIds.add(id);
				});
				first = false;
			} else {
				// Intersect with existing matches
				for (const id of matchingIds) {
					if (!tagIds.has(id)) {
						matchingIds.delete(id);
					}
				}
			}
		}

		return Array.from(matchingIds)
			.map((id) => this.artifacts.get(id))
			.filter((a): a is Artifact => !!a);
	}

	async delete(id: string): Promise<boolean> {
		const artifact = this.artifacts.get(id);
		if (!artifact) {
			return false;
		}

		// Remove from type index
		this.typeIndex.get(artifact.type)?.delete(id);

		// Remove from step index
		this.stepIndex.get(artifact.createdBy)?.delete(id);

		// Remove from tag index
		if (artifact.tags) {
			for (const tag of artifact.tags) {
				this.tagIndex.get(tag)?.delete(id);
			}
		}

		// Remove artifact
		this.artifacts.delete(id);
		return true;
	}

	async listIds(): Promise<string[]> {
		return Array.from(this.artifacts.keys());
	}

	async clear(): Promise<void> {
		this.artifacts.clear();
		this.typeIndex.clear();
		this.stepIndex.clear();
		this.tagIndex.clear();
	}

	/**
	 * Get statistics about stored artifacts.
	 */
	getStats(): {
		totalCount: number;
		byType: Record<string, number>;
		byStep: Record<string, number>;
	} {
		const byType: Record<string, number> = {};
		for (const [type, ids] of this.typeIndex) {
			byType[type] = ids.size;
		}

		const byStep: Record<string, number> = {};
		for (const [step, ids] of this.stepIndex) {
			byStep[step] = ids.size;
		}

		return {
			totalCount: this.artifacts.size,
			byType,
			byStep,
		};
	}
}

// =============================================================================
// Artifact Factory Functions
// =============================================================================

/**
 * Create a code artifact.
 */
export function createCodeArtifact(
	stepId: string,
	language: string,
	content: string,
	options?: {
		name?: string;
		filePath?: string;
		executionResult?: CodeArtifact["executionResult"];
		dependencies?: string[];
		tags?: string[];
	},
): CodeArtifact {
	return {
		id: `code-${randomUUID()}`,
		type: "code",
		createdBy: stepId,
		createdAt: new Date(),
		metadata: {},
		language,
		content,
		name: options?.name,
		filePath: options?.filePath,
		executionResult: options?.executionResult,
		dependencies: options?.dependencies,
		tags: options?.tags || ["code", language],
	};
}

/**
 * Create a document artifact.
 */
export function createDocumentArtifact(
	stepId: string,
	format: DocumentArtifact["format"],
	content: string,
	options?: {
		name?: string;
		title?: string;
		sections?: DocumentArtifact["sections"];
		sources?: string[];
		tags?: string[];
	},
): DocumentArtifact {
	return {
		id: `doc-${randomUUID()}`,
		type: "document",
		createdBy: stepId,
		createdAt: new Date(),
		metadata: {},
		format,
		content,
		name: options?.name,
		title: options?.title,
		sections: options?.sections,
		wordCount: content.split(/\s+/).length,
		sources: options?.sources,
		tags: options?.tags || ["document", format],
	};
}

/**
 * Create a data artifact.
 */
export function createDataArtifact(
	stepId: string,
	format: DataArtifact["format"],
	data: unknown,
	options?: {
		name?: string;
		schema?: Record<string, unknown>;
		columns?: string[];
		tags?: string[];
	},
): DataArtifact {
	const recordCount = Array.isArray(data) ? data.length : undefined;

	return {
		id: `data-${randomUUID()}`,
		type: "data",
		createdBy: stepId,
		createdAt: new Date(),
		metadata: {},
		format,
		data,
		name: options?.name,
		schema: options?.schema,
		recordCount,
		columns: options?.columns,
		tags: options?.tags || ["data", format],
	};
}

/**
 * Create an API response artifact.
 */
export function createApiResponseArtifact(
	stepId: string,
	endpoint: string,
	method: ApiResponseArtifact["method"],
	statusCode: number,
	body: unknown,
	options?: {
		name?: string;
		headers?: Record<string, string>;
		request?: ApiResponseArtifact["request"];
		responseTimeMs?: number;
		tags?: string[];
	},
): ApiResponseArtifact {
	return {
		id: `api-${randomUUID()}`,
		type: "api_response",
		createdBy: stepId,
		createdAt: new Date(),
		metadata: {},
		endpoint,
		method,
		statusCode,
		headers: options?.headers || {},
		body,
		request: options?.request,
		responseTimeMs: options?.responseTimeMs || 0,
		tags: options?.tags || ["api", method.toLowerCase()],
	};
}

/**
 * Create a tool result artifact.
 */
export function createToolResultArtifact(
	stepId: string,
	toolName: string,
	serverName: string,
	args: Record<string, unknown>,
	result: unknown,
	success: boolean,
	options?: {
		name?: string;
		errorMessage?: string;
		durationMs?: number;
		cached?: boolean;
		tags?: string[];
	},
): ToolResultArtifact {
	return {
		id: `tool-${randomUUID()}`,
		type: "tool_result",
		createdBy: stepId,
		createdAt: new Date(),
		metadata: {},
		toolName,
		serverName,
		args,
		result,
		success,
		name: options?.name,
		errorMessage: options?.errorMessage,
		durationMs: options?.durationMs || 0,
		cached: options?.cached,
		tags: options?.tags || ["tool", toolName, serverName],
	};
}

/**
 * Create a summary artifact.
 */
export function createSummaryArtifact(
	stepId: string,
	summary: string,
	keyPoints: string[],
	sourceArtifacts: string[],
	options?: {
		name?: string;
		confidence?: number;
		tags?: string[];
	},
): SummaryArtifact {
	return {
		id: `summary-${randomUUID()}`,
		type: "summary",
		createdBy: stepId,
		createdAt: new Date(),
		metadata: {},
		summary,
		keyPoints,
		sourceArtifacts,
		name: options?.name,
		confidence: options?.confidence || 0.8,
		tags: options?.tags || ["summary"],
	};
}

/**
 * Create an error artifact.
 */
export function createErrorArtifact(
	stepId: string,
	errorMessage: string,
	options?: {
		name?: string;
		errorCode?: string;
		stackTrace?: string;
		failedStepId?: string;
		recoveryAttempt?: string;
		recovered?: boolean;
		tags?: string[];
	},
): ErrorArtifact {
	return {
		id: `error-${randomUUID()}`,
		type: "error",
		createdBy: stepId,
		createdAt: new Date(),
		metadata: {},
		errorMessage,
		name: options?.name,
		errorCode: options?.errorCode,
		stackTrace: options?.stackTrace,
		failedStepId: options?.failedStepId,
		recoveryAttempt: options?.recoveryAttempt,
		recovered: options?.recovered || false,
		tags: options?.tags || ["error"],
	};
}

/**
 * Create a browser state artifact.
 */
export function createBrowserStateArtifact(
	stepId: string,
	url: string,
	options?: {
		name?: string;
		title?: string;
		screenshot?: string;
		domSnapshot?: string;
		textContent?: string;
		cookies?: BrowserStateArtifact["cookies"];
		localStorage?: Record<string, string>;
		actionHistory?: BrowserStateArtifact["actionHistory"];
		tags?: string[];
	},
): BrowserStateArtifact {
	return {
		id: `browser-${randomUUID()}`,
		type: "browser_state",
		createdBy: stepId,
		createdAt: new Date(),
		metadata: {},
		url,
		name: options?.name,
		title: options?.title,
		screenshot: options?.screenshot,
		domSnapshot: options?.domSnapshot,
		textContent: options?.textContent,
		cookies: options?.cookies,
		localStorage: options?.localStorage,
		actionHistory: options?.actionHistory,
		tags: options?.tags || ["browser", new URL(url).hostname],
	};
}

/**
 * Create a file artifact.
 */
export function createFileArtifact(
	stepId: string,
	fileName: string,
	filePath: string,
	mimeType: string,
	sizeBytes: number,
	options?: {
		name?: string;
		content?: string;
		url?: string;
		checksum?: string;
		tags?: string[];
	},
): FileArtifact {
	return {
		id: `file-${randomUUID()}`,
		type: "file",
		createdBy: stepId,
		createdAt: new Date(),
		metadata: {},
		fileName,
		filePath,
		mimeType,
		sizeBytes,
		name: options?.name,
		content: options?.content,
		url: options?.url,
		checksum: options?.checksum,
		tags: options?.tags || ["file", mimeType.split("/")[0]],
	};
}

// =============================================================================
// Artifact Transformers
// =============================================================================

/**
 * Extract key data from a tool result artifact.
 */
export function extractDataFromToolResult(
	artifact: ToolResultArtifact,
): DataArtifact | null {
	if (!artifact.success || !artifact.result) {
		return null;
	}

	const result = artifact.result;
	let format: DataArtifact["format"] = "object";
	let columns: string[] | undefined;

	if (Array.isArray(result)) {
		format = "array";
		if (result.length > 0 && typeof result[0] === "object") {
			columns = Object.keys(result[0] as object);
		}
	}

	return createDataArtifact(artifact.createdBy, format, result, {
		name: `Data from ${artifact.toolName}`,
		columns,
		tags: ["extracted", artifact.toolName],
	});
}

/**
 * Summarize multiple artifacts into a single summary artifact.
 */
export function summarizeArtifacts(
	stepId: string,
	artifacts: Artifact[],
	summaryText: string,
	keyPoints: string[],
): SummaryArtifact {
	return createSummaryArtifact(
		stepId,
		summaryText,
		keyPoints,
		artifacts.map((a) => a.id),
		{
			name: `Summary of ${artifacts.length} artifacts`,
			confidence: 0.75,
			tags: ["summary", "aggregated"],
		},
	);
}

/**
 * Convert artifact to a token-efficient string representation.
 */
export function artifactToString(artifact: Artifact, maxLength = 500): string {
	switch (artifact.type) {
		case "code":
			return `[Code: ${artifact.language}] ${artifact.content.slice(0, maxLength)}${artifact.content.length > maxLength ? "..." : ""}`;

		case "document":
			return `[Document: ${artifact.title || "Untitled"}] ${artifact.content.slice(0, maxLength)}${artifact.content.length > maxLength ? "..." : ""}`;

		case "data": {
			const dataStr = JSON.stringify(artifact.data, null, 2);
			return `[Data: ${artifact.format}${artifact.recordCount ? `, ${artifact.recordCount} records` : ""}] ${dataStr.slice(0, maxLength)}${dataStr.length > maxLength ? "..." : ""}`;
		}

		case "api_response":
			return `[API: ${artifact.method} ${artifact.endpoint}] Status: ${artifact.statusCode}`;

		case "tool_result": {
			const resultStr = JSON.stringify(artifact.result, null, 2);
			return `[Tool: ${artifact.toolName}] ${artifact.success ? "Success" : "Failed"}: ${resultStr.slice(0, maxLength)}${resultStr.length > maxLength ? "..." : ""}`;
		}

		case "summary":
			return `[Summary] ${artifact.summary.slice(0, maxLength)}${artifact.summary.length > maxLength ? "..." : ""}`;

		case "browser_state":
			return `[Browser: ${artifact.url}] ${artifact.title || ""}`;

		case "file":
			return `[File: ${artifact.fileName}] ${artifact.mimeType}, ${artifact.sizeBytes} bytes`;

		case "error":
			return `[Error: ${artifact.errorCode || "unknown"}] ${artifact.errorMessage}`;

		default:
			return `[${artifact.type}] ${artifact.name || artifact.id}`;
	}
}

/**
 * Get a compact representation of all artifacts for context injection.
 */
export function getArtifactsContext(
	store: ArtifactStore,
	artifactIds: string[],
	maxTotalLength = 2000,
): Promise<string> {
	return Promise.resolve().then(async () => {
		const artifacts: Artifact[] = [];
		for (const id of artifactIds) {
			const artifact = await store.get(id);
			if (artifact) {
				artifacts.push(artifact);
			}
		}

		if (artifacts.length === 0) {
			return "";
		}

		const perArtifactLength = Math.floor(maxTotalLength / artifacts.length);
		const strings = artifacts.map((a) =>
			artifactToString(a, perArtifactLength),
		);

		return `=== Available Artifacts ===\n${strings.join("\n")}`;
	});
}
