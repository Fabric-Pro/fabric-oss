/**
 * Audio/Video Transcription for Fabric AI
 *
 * Uses AI SDK's experimental_transcribe to support:
 * - Direct provider access (OpenAI, Groq, etc.)
 * - AI Gateway routing (looks up enabled sub-providers since gateway doesn't support transcription directly)
 *
 * **IMPORTANT**: Vercel AI Gateway currently doesn't have a `.transcription()` method.
 * When a user has AI Gateway configured, we look at their `enabledProviders` array
 * and use the first provider that supports transcription (OpenAI or Groq).
 *
 * Execution modes:
 * - hybrid: Uses user's configured AI provider (respects gateway settings)
 * - delegated: Passes user's API key to Fabric AI (requires Fabric AI modification)
 * - full: Uses Fabric AI's configured API keys
 *
 * Supported providers and models:
 * - OpenAI: whisper-1, gpt-4o-transcribe, gpt-4o-mini-transcribe
 * - Groq: whisper-large-v3-turbo, whisper-large-v3
 */

import { createGroq } from "@ai-sdk/groq";
import { createOpenAI } from "@ai-sdk/openai";
import { getSystemRAGProviderConfig } from "@repo/ai";
import { logAiUsageAsync } from "@repo/database";
import type { AIProvider } from "@repo/database/prisma/generated/client";
import { logger } from "@repo/logs";
import { withProviderBreaker } from "@repo/observability";
import { experimental_transcribe as transcribe } from "ai";
import { createFabricClient } from "./client";
import { executeFabricPattern, getFabricAIMode } from "./executor";
import type { FabricAIMode, FabricConfig, FabricPattern } from "./types";

/** Maximum file size for OpenAI Whisper API (25MB) */
export const MAX_AUDIO_FILE_SIZE = 25 * 1024 * 1024;

/** Allowed transcription models by provider */
export const TRANSCRIPTION_MODELS = {
	openai: [
		"whisper-1",
		"gpt-4o-transcribe",
		"gpt-4o-mini-transcribe",
	] as const,
	groq: ["whisper-large-v3-turbo", "whisper-large-v3"] as const,
} as const;

export type OpenAITranscriptionModel =
	(typeof TRANSCRIPTION_MODELS.openai)[number];
export type GroqTranscriptionModel = (typeof TRANSCRIPTION_MODELS.groq)[number];
export type TranscriptionModel =
	| OpenAITranscriptionModel
	| GroqTranscriptionModel
	| string;

/** Allowed audio file extensions */
export const ALLOWED_AUDIO_EXTENSIONS = [
	".mp3",
	".mp4",
	".mpeg",
	".mpga",
	".m4a",
	".wav",
	".webm",
] as const;

/** User context for API key resolution */
export interface UserContext {
	userId: string;
	organizationId?: string;
}

/**
 * Options for audio transcription
 */
export interface TranscriptionOptions {
	/** Transcription model to use (defaults to whisper-1) */
	model?: TranscriptionModel;
	/** User context for API key resolution (required for hybrid mode) */
	userContext?: UserContext;
	/** Override the execution mode */
	mode?: FabricAIMode;
	/** Fabric AI config overrides (for delegated/full modes) */
	fabricConfig?: Partial<FabricConfig>;
	/** Language code (e.g., "en", "es", "fr") */
	language?: string;
}

/**
 * Result of audio transcription
 */
export interface TranscriptionResult {
	/** The transcribed text */
	transcript: string;
	/** Whether the transcription was successful */
	success: boolean;
	/** Error message if failed */
	error?: string;
	/** Metadata about the transcription */
	metadata: {
		/** Model used */
		model: string;
		/** Execution mode used */
		executionMode: string;
		/** Duration in milliseconds */
		durationMs: number;
		/** Detected language (if available) */
		language?: string;
		/** Duration of the audio in seconds (if available) */
		audioDurationSeconds?: number;
	};
}

/**
 * Get MIME type from file name
 */
function _getMimeType(fileName: string): string {
	const ext = fileName.toLowerCase().split(".").pop();
	const mimeTypes: Record<string, string> = {
		mp3: "audio/mpeg",
		mp4: "video/mp4",
		mpeg: "audio/mpeg",
		mpga: "audio/mpeg",
		m4a: "audio/m4a",
		wav: "audio/wav",
		webm: "audio/webm",
	};
	return mimeTypes[ext || ""] || "audio/mpeg";
}

/**
 * Validate file extension
 */
function validateFileExtension(fileName: string): boolean {
	const ext = `.${fileName.toLowerCase().split(".").pop()}`;
	return ALLOWED_AUDIO_EXTENSIONS.includes(
		ext as (typeof ALLOWED_AUDIO_EXTENSIONS)[number],
	);
}

/**
 * Parse model string to extract provider and model name
 * Supports formats: "whisper-1", "openai/whisper-1", "groq/whisper-large-v3"
 */
function parseModelString(model: string): {
	provider: string;
	modelName: string;
} {
	if (model.includes("/")) {
		const [provider, ...rest] = model.split("/");
		return { provider, modelName: rest.join("/") };
	}
	// Default to OpenAI for whisper models
	if (model.startsWith("whisper") || model.startsWith("gpt-4o")) {
		return { provider: "openai", modelName: model };
	}
	return { provider: "openai", modelName: model };
}

/**
 * Provider slugs that can appear in a hybrid-mode metadata.model prefix,
 * mapped to their AiUsageLog enum values.
 */
const TRANSCRIPTION_PROVIDER_ENUM: Record<string, AIProvider> = {
	openai: "OPENAI_DIRECT",
	openai_direct: "OPENAI_DIRECT",
	groq: "GROQ",
};

/**
 * Best-effort usage row for one transcription call (Fizzy #1894).
 *
 * Transcription is billed per audio minute, not per token, and the AI SDK's
 * transcribe result exposes no token counts — so this is an invocation
 * marker (zero tokens, zero cost), not a spend figure. It exists so
 * transcription shows up in the AI usage ledger at all. Fire-and-forget: a
 * logging failure must never break the transcription itself.
 */
function logTranscriptionUsage(
	result: TranscriptionResult,
	userContext?: UserContext,
): void {
	// Hybrid metadata carries "<provider>/<model>"; delegated/full run
	// server-side and report only the model name, so their provider is unknown
	// here and lands under CUSTOM.
	const [providerSlug] = result.metadata.model.split("/");
	try {
		logAiUsageAsync({
			userId: userContext?.userId,
			organizationId: userContext?.organizationId,
			provider:
				result.metadata.executionMode === "hybrid"
					? (TRANSCRIPTION_PROVIDER_ENUM[providerSlug] ?? "CUSTOM")
					: "CUSTOM",
			providerModelId: result.metadata.model,
			taskType: "AUDIO",
			jobType: "transcription",
			inputTokens: 0,
			outputTokens: 0,
			totalTokens: 0,
			latencyMs: result.metadata.durationMs,
			success: result.success,
			errorMessage: result.error,
		});
	} catch {
		/* never propagate a logging failure */
	}
}

// ============================================================================
// Hybrid Mode - Uses user's AI Gateway or direct provider API key
// ============================================================================

/** Providers that support transcription */
const TRANSCRIPTION_CAPABLE_PROVIDERS = ["openai", "groq"] as const;

/**
 * Get the best transcription provider from user's enabled providers
 */
function getTranscriptionProvider(
	enabledProviders: string[],
	requestedProvider: string,
): string {
	// If user explicitly requested a provider and it's in their enabled list
	if (
		enabledProviders
			.map((p) => p.toLowerCase())
			.includes(requestedProvider.toLowerCase())
	) {
		return requestedProvider.toLowerCase();
	}

	// Find the first transcription-capable provider
	for (const provider of TRANSCRIPTION_CAPABLE_PROVIDERS) {
		if (enabledProviders.map((p) => p.toLowerCase()).includes(provider)) {
			return provider;
		}
	}

	// Default to openai (most common)
	return "openai";
}

/**
 * Transcribe audio using hybrid mode
 *
 * Uses the AI SDK's experimental_transcribe function.
 *
 * NOTE: Vercel AI Gateway doesn't support transcription routing directly.
 * When user has AI Gateway configured, we look at their enabledProviders
 * and use the appropriate provider's transcription API directly.
 */
async function transcribeHybrid(
	fileContent: Buffer | Blob,
	_fileName: string,
	model: TranscriptionModel,
	userContext?: UserContext,
	language?: string,
): Promise<TranscriptionResult> {
	const startTime = Date.now();
	const { provider: requestedProvider, modelName } = parseModelString(model);

	try {
		if (!userContext?.userId) {
			throw new Error("User context required for hybrid mode");
		}

		// Get user's AI provider configuration using centralized entry point.
		// SYSTEM side: nobody is waiting here — transcription is only reachable
		// through the `transcribeAudio` temporal activity, where a refusal is
		// retried five times before failing the workflow.
		const providerConfig = await getSystemRAGProviderConfig({
			userId: userContext.userId,
			organizationId: userContext.organizationId ?? undefined,
		});

		// providerConfig.apiKey is already decrypted by getSystemRAGProviderConfig()
		const apiKey = providerConfig.apiKey;

		// Determine which provider to use for transcription
		// AI Gateway doesn't support transcription, so we use the underlying provider directly
		const effectiveProvider =
			providerConfig.provider === "VERCEL_GATEWAY"
				? getTranscriptionProvider(
						providerConfig.enabledProviders,
						requestedProvider,
					)
				: providerConfig.provider?.toLowerCase() || requestedProvider;

		// Select the appropriate model based on provider
		let transcriptionModel: unknown;
		let finalModelName = modelName;

		if (effectiveProvider === "groq") {
			// Groq uses different model names
			if (!modelName.startsWith("whisper-large")) {
				finalModelName = "whisper-large-v3-turbo"; // Groq's default fast model
			}
			const groq = createGroq({ apiKey });
			transcriptionModel = groq.transcription(
				finalModelName as GroqTranscriptionModel,
			);
		} else {
			// OpenAI (default)
			const openai = createOpenAI({
				apiKey,
				// Don't use gateway baseURL for transcription since it doesn't support it
				baseURL:
					providerConfig.provider !== "VERCEL_GATEWAY"
						? providerConfig.baseUrl || undefined
						: undefined,
			});
			transcriptionModel = openai.transcription(
				finalModelName as OpenAITranscriptionModel,
			);
		}

		// Convert to Uint8Array for the AI SDK (it accepts DataContent which includes Uint8Array)
		let audioData: Uint8Array;
		if (Buffer.isBuffer(fileContent)) {
			audioData = new Uint8Array(fileContent);
		} else {
			// Convert Blob to ArrayBuffer then to Uint8Array
			const arrayBuffer = await (fileContent as Blob).arrayBuffer();
			audioData = new Uint8Array(arrayBuffer);
		}

		// Perform transcription using AI SDK. Only OpenAI hits an MVP-5
		// provider that has a registered breaker — Groq does not. Skip
		// the wrapper for non-OpenAI providers so we never throw "no
		// breaker configured" at runtime for them.
		// Note: Using 'as any' because there's a version mismatch between TranscriptionModelV1/V2/V3
		const transcribeCall = () =>
			transcribe({
				model: transcriptionModel as any,
				audio: audioData,
				providerOptions: language
					? { openai: { language } }
					: undefined,
			});
		const result =
			effectiveProvider === "openai"
				? await withProviderBreaker(
						"openai",
						"transcription",
						transcribeCall,
					)
				: await transcribeCall();

		return {
			transcript: result.text,
			success: true,
			metadata: {
				model: `${effectiveProvider}/${finalModelName}`,
				executionMode: "hybrid",
				durationMs: Date.now() - startTime,
				language: result.language,
				audioDurationSeconds: result.durationInSeconds,
			},
		};
	} catch (err) {
		const errorMessage = err instanceof Error ? err.message : String(err);
		logger.error("Hybrid transcription failed", { error: errorMessage });
		return {
			transcript: "",
			success: false,
			error: errorMessage,
			metadata: {
				model: `${requestedProvider}/${modelName}`,
				executionMode: "hybrid",
				durationMs: Date.now() - startTime,
			},
		};
	}
}

// ============================================================================
// Delegated Mode - Passes user's API key to Fabric AI server
// ============================================================================

/**
 * Transcribe audio using delegated mode
 *
 * Sends user's API key to Fabric AI server which performs the transcription.
 * Falls back to hybrid mode if Fabric AI doesn't support delegated transcription.
 */
async function transcribeDelegated(
	fileContent: Buffer | Blob,
	fileName: string,
	model: TranscriptionModel,
	userContext?: UserContext,
	fabricConfig?: Partial<FabricConfig>,
	language?: string,
): Promise<TranscriptionResult> {
	const startTime = Date.now();
	const { modelName } = parseModelString(model);

	try {
		if (!userContext?.userId) {
			throw new Error("User context required for delegated mode");
		}

		// Get user's API key for delegation using centralized entry point.
		// SYSTEM side, same reason as the hybrid path above: this runs inside the
		// transcription activity, not on a request a person is holding open.
		const providerConfig = await getSystemRAGProviderConfig({
			userId: userContext.userId,
			organizationId: userContext.organizationId ?? undefined,
		});

		// providerConfig.apiKey is already decrypted by getSystemRAGProviderConfig()
		const apiKey = providerConfig.apiKey;

		// Create Fabric client
		const fabricClient = createFabricClient(fabricConfig);
		const baseUrl = fabricClient.getBaseUrl();
		const fabricApiKey = fabricClient.getApiKey();

		// Convert Buffer to Uint8Array for FormData
		const fileData = Buffer.isBuffer(fileContent)
			? new Uint8Array(fileContent)
			: fileContent;

		// Create form data
		const formData = new FormData();
		formData.append("file", new Blob([fileData]), fileName);
		formData.append("model", modelName);
		formData.append("apiKey", apiKey);
		if (language) {
			formData.append("language", language);
		}

		// Call Fabric AI's delegated transcription endpoint
		const response = await fetch(`${baseUrl}/transcribe/delegated`, {
			method: "POST",
			headers: fabricApiKey ? { "X-API-Key": fabricApiKey } : {},
			body: formData,
		});

		if (!response.ok) {
			if (response.status === 404) {
				// Delegated mode not supported, fall back to hybrid
				logger.warn(
					"Delegated transcription not supported, falling back to hybrid",
				);
				return transcribeHybrid(
					fileContent,
					fileName,
					model,
					userContext,
					language,
				);
			}
			const errorBody = await response.text();
			throw new Error(
				`Fabric transcription error (${response.status}): ${errorBody}`,
			);
		}

		const result = (await response.json()) as {
			transcript: string;
			language?: string;
			duration?: number;
		};

		return {
			transcript: result.transcript,
			success: true,
			metadata: {
				model: modelName,
				executionMode: "delegated",
				durationMs: Date.now() - startTime,
				language: result.language,
				audioDurationSeconds: result.duration,
			},
		};
	} catch (err) {
		const errorMessage = err instanceof Error ? err.message : String(err);
		logger.error("Delegated transcription failed", { error: errorMessage });
		return {
			transcript: "",
			success: false,
			error: errorMessage,
			metadata: {
				model: modelName,
				executionMode: "delegated",
				durationMs: Date.now() - startTime,
			},
		};
	}
}

// ============================================================================
// Full Mode - Uses Fabric AI's own configured API keys
// ============================================================================

/**
 * Transcribe audio using full mode
 *
 * Uses Fabric AI server's own API keys. No user isolation.
 */
async function transcribeFull(
	fileContent: Buffer | Blob,
	fileName: string,
	model: TranscriptionModel,
	fabricConfig?: Partial<FabricConfig>,
	language?: string,
): Promise<TranscriptionResult> {
	const startTime = Date.now();
	const { modelName } = parseModelString(model);

	try {
		const fabricClient = createFabricClient(fabricConfig);
		const baseUrl = fabricClient.getBaseUrl();
		const fabricApiKey = fabricClient.getApiKey();

		// Convert Buffer to Uint8Array for FormData
		const fileData = Buffer.isBuffer(fileContent)
			? new Uint8Array(fileContent)
			: fileContent;

		// Create form data
		const formData = new FormData();
		formData.append("file", new Blob([fileData]), fileName);
		formData.append("model", modelName);
		if (language) {
			formData.append("language", language);
		}

		// Call Fabric AI's transcription endpoint
		const response = await fetch(`${baseUrl}/transcribe`, {
			method: "POST",
			headers: fabricApiKey ? { "X-API-Key": fabricApiKey } : {},
			body: formData,
		});

		if (!response.ok) {
			const errorBody = await response.text();
			throw new Error(
				`Fabric transcription error (${response.status}): ${errorBody}`,
			);
		}

		const result = (await response.json()) as {
			transcript: string;
			language?: string;
			duration?: number;
		};

		return {
			transcript: result.transcript,
			success: true,
			metadata: {
				model: modelName,
				executionMode: "full",
				durationMs: Date.now() - startTime,
				language: result.language,
				audioDurationSeconds: result.duration,
			},
		};
	} catch (err) {
		const errorMessage = err instanceof Error ? err.message : String(err);
		logger.error("Full mode transcription failed", { error: errorMessage });
		return {
			transcript: "",
			success: false,
			error: errorMessage,
			metadata: {
				model: modelName,
				executionMode: "full",
				durationMs: Date.now() - startTime,
			},
		};
	}
}

// ============================================================================
// Main Transcription Function
// ============================================================================

/**
 * Transcribe an audio/video file
 *
 * Automatically routes to the correct mode based on configuration:
 * - hybrid: Uses user's AI Gateway or direct provider (respects user config)
 * - delegated: Uses Fabric AI with user's credentials
 * - full: Uses Fabric AI's own API keys
 *
 * @param fileContent - Audio file content as Buffer or Blob
 * @param fileName - Original file name (for extension detection)
 * @param options - Transcription options
 */
export async function transcribeAudio(
	fileContent: Buffer | Blob,
	fileName: string,
	options: TranscriptionOptions = {},
): Promise<TranscriptionResult> {
	const {
		model = "whisper-1",
		userContext,
		mode = getFabricAIMode(),
		fabricConfig,
		language,
	} = options;

	// Validate file extension
	if (!validateFileExtension(fileName)) {
		return {
			transcript: "",
			success: false,
			error: `Unsupported file format. Allowed: ${ALLOWED_AUDIO_EXTENSIONS.join(", ")}`,
			metadata: {
				model,
				executionMode: mode,
				durationMs: 0,
			},
		};
	}

	// Check file size
	const fileSize = Buffer.isBuffer(fileContent)
		? fileContent.length
		: (fileContent as Blob).size;
	if (fileSize > MAX_AUDIO_FILE_SIZE) {
		return {
			transcript: "",
			success: false,
			error: `File exceeds 25MB limit (${Math.round(fileSize / 1024 / 1024)}MB). File splitting not yet implemented.`,
			metadata: {
				model,
				executionMode: mode,
				durationMs: 0,
			},
		};
	}

	// Route to the appropriate mode
	let result: TranscriptionResult;
	switch (mode) {
		case "hybrid":
			result = await transcribeHybrid(
				fileContent,
				fileName,
				model,
				userContext,
				language,
			);
			break;

		case "delegated":
			result = await transcribeDelegated(
				fileContent,
				fileName,
				model,
				userContext,
				fabricConfig,
				language,
			);
			break;

		case "full":
			result = await transcribeFull(
				fileContent,
				fileName,
				model,
				fabricConfig,
				language,
			);
			break;

		default:
			throw new Error(`Unknown transcription mode: ${mode}`);
	}

	logTranscriptionUsage(result, userContext);
	return result;
}

// ============================================================================
// Transcribe and Analyze (combined function)
// ============================================================================

export interface TranscribeAndAnalyzeOptions extends TranscriptionOptions {
	/** Pattern to execute on the transcript */
	pattern: FabricPattern;
	/** Pattern variables */
	variables?: Record<string, string>;
	/** Context name to include */
	context?: string;
	/** Strategy name to use */
	strategy?: string;
	/** Transcription model (defaults to whisper-1) */
	transcriptionModel?: TranscriptionModel;
}

export interface TranscribeAndAnalyzeResult {
	/** The transcribed text */
	transcript?: string;
	/** The analysis result from the pattern */
	analysis?: string;
	/** Whether the operation was successful */
	success: boolean;
	/** Error message if failed */
	error?: string;
}

/**
 * Transcribe an audio file and analyze it with a Fabric pattern
 *
 * This is a convenience function that combines transcription and pattern execution.
 */
export async function transcribeAndAnalyze(
	options: TranscribeAndAnalyzeOptions & {
		fileContent: Buffer | Blob;
		fileName: string;
	},
): Promise<TranscribeAndAnalyzeResult> {
	const {
		fileContent,
		fileName,
		pattern,
		variables,
		context,
		strategy,
		transcriptionModel = "whisper-1",
		userContext,
		mode,
		fabricConfig,
		language,
	} = options;

	// Step 1: Transcribe the audio
	const transcriptionResult = await transcribeAudio(fileContent, fileName, {
		model: transcriptionModel,
		userContext,
		mode,
		fabricConfig,
		language,
	});

	if (!transcriptionResult.success) {
		return {
			success: false,
			error: `Transcription failed: ${transcriptionResult.error}`,
		};
	}

	// Step 2: Analyze with pattern
	const analysisResult = await executeFabricPattern({
		pattern,
		input: transcriptionResult.transcript,
		variables,
		context,
		strategy,
		mode: mode || getFabricAIMode(),
		userContext,
		fabricConfig,
	});

	if (!analysisResult.success) {
		return {
			transcript: transcriptionResult.transcript,
			success: false,
			error: `Analysis failed: ${analysisResult.error}`,
		};
	}

	return {
		transcript: transcriptionResult.transcript,
		analysis: analysisResult.output,
		success: true,
	};
}
