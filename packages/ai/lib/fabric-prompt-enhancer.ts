/**
 * Fabric AI Prompt Enhancement Utility
 *
 * Provides system-wide Fabric AI integration for prompt enhancement.
 * Uses Strategy → Context → Pattern composition to improve AI outputs.
 *
 * This utility is designed to be imported across the codebase:
 * - API routes (chat, workspace chat)
 * - Temporal workflows (direct-chat, orchestrator)
 * - LangChain agents
 * - CopilotKit handlers
 *
 * Usage:
 * ```typescript
 * import { enhancePromptWithFabric, isFabricEnabled } from "@repo/ai";
 *
 * // Simple usage with auto-detection
 * const enhanced = await enhancePromptWithFabric({
 *   userMessage: "Analyze this code for security vulnerabilities",
 *   basePrompt: "You are a helpful assistant.",
 * });
 *
 * // Use enhanced.systemPrompt in your AI call
 * ```
 */

import http from "node:http";
import https from "node:https";

// =============================================================================
// Configuration
// =============================================================================

const FABRIC_AI_URL = process.env.FABRIC_AI_URL || "http://localhost:8080";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const REQUEST_TIMEOUT_MS = 3000; // 3 second timeout for Fabric AI calls

// =============================================================================
// Types
// =============================================================================

export interface FabricEnhanceOptions {
	/** User message to analyze for auto-detection */
	userMessage: string;
	/** Base system prompt to enhance */
	basePrompt?: string;
	/** Force specific strategy (skips auto-detection) */
	strategy?: string;
	/** Force specific context/persona (skips auto-detection) */
	context?: string;
	/** Force specific pattern (skips auto-detection) */
	pattern?: string;
	/** Variables to inject into patterns */
	variables?: Record<string, string>;
	/** Skip enhancement if Fabric AI is unavailable (default: true) */
	gracefulFallback?: boolean;
}

export interface FabricEnhanceResult {
	/** Enhanced system prompt (or original if Fabric unavailable) */
	systemPrompt: string;
	/** Components that were applied */
	components: {
		strategy: string | null;
		context: string | null;
		pattern: string | null;
	};
	/** Whether Fabric AI was used */
	fabricUsed: boolean;
	/** Whether fallback was used due to unavailability */
	fallbackUsed: boolean;
	/** Cache hit information */
	cacheHits?: {
		strategy: boolean;
		context: boolean;
		pattern: boolean;
	};
}

interface FabricStrategy {
	name: string;
	description: string;
	prompt: string;
}

interface FabricContext {
	name: string;
	content: string;
}

interface FabricPattern {
	name: string;
	pattern: string;
	description?: string;
}

// =============================================================================
// Cache Implementation
// =============================================================================

interface CacheEntry<T> {
	data: T;
	timestamp: number;
}

class FabricCache {
	private strategies = new Map<string, CacheEntry<FabricStrategy>>();
	private contexts = new Map<string, CacheEntry<FabricContext>>();
	private patterns = new Map<string, CacheEntry<FabricPattern>>();
	private availabilityCache: CacheEntry<boolean> | null = null;

	private isValid<T>(entry: CacheEntry<T> | null): entry is CacheEntry<T> {
		if (!entry) {
			return false;
		}
		return Date.now() - entry.timestamp < CACHE_TTL_MS;
	}

	getAvailability(): boolean | null {
		// Shorter TTL for availability check (30 seconds)
		if (
			this.availabilityCache &&
			Date.now() - this.availabilityCache.timestamp < 30000
		) {
			return this.availabilityCache.data;
		}
		return null;
	}

	setAvailability(available: boolean): void {
		this.availabilityCache = { data: available, timestamp: Date.now() };
	}

	getStrategy(name: string): FabricStrategy | null {
		const entry = this.strategies.get(name) ?? null;
		return this.isValid(entry) ? entry.data : null;
	}

	setStrategy(name: string, data: FabricStrategy): void {
		this.strategies.set(name, { data, timestamp: Date.now() });
	}

	getContext(name: string): FabricContext | null {
		const entry = this.contexts.get(name) ?? null;
		return this.isValid(entry) ? entry.data : null;
	}

	setContext(name: string, data: FabricContext): void {
		this.contexts.set(name, { data, timestamp: Date.now() });
	}

	getPattern(name: string): FabricPattern | null {
		const entry = this.patterns.get(name) ?? null;
		return this.isValid(entry) ? entry.data : null;
	}

	setPattern(name: string, data: FabricPattern): void {
		this.patterns.set(name, { data, timestamp: Date.now() });
	}

	clear(): void {
		this.strategies.clear();
		this.contexts.clear();
		this.patterns.clear();
		this.availabilityCache = null;
	}
}

// Global cache instance
const globalCache = new FabricCache();

// =============================================================================
// HTTP Client
// =============================================================================

async function fetchFabricJson<T>(path: string): Promise<T | null> {
	return new Promise((resolve) => {
		const url = `${FABRIC_AI_URL}${path}`;
		const client = url.startsWith("https://") ? https : http;
		const req = client.get(url, { timeout: REQUEST_TIMEOUT_MS }, (res) => {
			if (res.statusCode !== 200) {
				resolve(null);
				return;
			}

			let data = "";
			res.on("data", (chunk) => {
				data += chunk;
			});
			res.on("end", () => {
				try {
					resolve(JSON.parse(data));
				} catch {
					resolve(null);
				}
			});
		});

		req.on("error", () => resolve(null));
		req.on("timeout", () => {
			req.destroy();
			resolve(null);
		});
	});
}

// =============================================================================
// Fabric AI API Functions
// =============================================================================

/** Check if Fabric AI server is available */
export async function isFabricAvailable(): Promise<boolean> {
	const cached = globalCache.getAvailability();
	if (cached !== null) {
		return cached;
	}

	const health = await fetchFabricJson<{ status: string }>("/health");
	const available = health?.status === "healthy";
	globalCache.setAvailability(available);
	return available;
}

/** Check if Fabric AI is enabled (URL configured and server available) */
export async function isFabricEnabled(): Promise<boolean> {
	if (!process.env.FABRIC_AI_URL) {
		return false;
	}
	return isFabricAvailable();
}

/** Get a specific strategy by name */
async function getStrategy(name: string): Promise<FabricStrategy | null> {
	const cached = globalCache.getStrategy(name);
	if (cached) {
		return cached;
	}

	const strategies = await fetchFabricJson<FabricStrategy[]>("/strategies");
	const strategy = strategies?.find((s) => s.name === name);

	if (strategy) {
		globalCache.setStrategy(name, strategy);
		return strategy;
	}
	return null;
}

/** Get a specific context by name */
async function getContext(name: string): Promise<FabricContext | null> {
	const cached = globalCache.getContext(name);
	if (cached) {
		return cached;
	}

	const content = await fetchFabricJson<string>(
		`/contexts/${encodeURIComponent(name)}`,
	);

	if (content) {
		const context: FabricContext = { name, content };
		globalCache.setContext(name, context);
		return context;
	}
	return null;
}

/** Get a specific pattern by name */
async function getPattern(name: string): Promise<FabricPattern | null> {
	const cached = globalCache.getPattern(name);
	if (cached) {
		return cached;
	}

	const data = await fetchFabricJson<{
		Name: string;
		Pattern: string;
		Description?: string;
	}>(`/patterns/${encodeURIComponent(name)}`);

	if (data) {
		const pattern: FabricPattern = {
			name: data.Name,
			pattern: data.Pattern,
			description: data.Description,
		};
		globalCache.setPattern(name, pattern);
		return pattern;
	}
	return null;
}

// =============================================================================
// Auto-Detection Rules
// =============================================================================

/** Task type detection rules for auto-enhancement */
const TASK_DETECTION_RULES: Array<{
	keywords: string[];
	pattern?: string;
	context?: string;
	strategy?: string;
}> = [
	// Security analysis
	{
		keywords: [
			"vulnerability",
			"vulnerabilities",
			"security",
			"exploit",
			"injection",
			"xss",
			"csrf",
			"pentest",
		],
		pattern: "find_vulnerabilities",
		context: "security_expert",
		strategy: "cot",
	},
	// Code review
	{
		keywords: [
			"review code",
			"code review",
			"pr review",
			"pull request review",
			"review my code",
		],
		pattern: "review_code",
		context: "senior_dev",
	},
	// Code explanation
	{
		keywords: [
			"explain code",
			"what does this code",
			"how does this code",
			"understand this code",
		],
		pattern: "explain_code",
	},
	// Summarization
	{
		keywords: [
			"summarize",
			"summary",
			"tldr",
			"brief overview",
			"key points",
			"main points",
		],
		pattern: "summarize",
	},
	// Analysis
	{
		keywords: [
			"analyze",
			"analyse",
			"evaluate",
			"assess",
			"examine",
			"investigate",
		],
		pattern: "analyze_claims",
		strategy: "cot",
	},
	// Extraction
	{
		keywords: [
			"extract",
			"find key",
			"identify main",
			"pull out",
			"get the main",
		],
		pattern: "extract_wisdom",
	},
	// Writing improvement
	{
		keywords: [
			"improve writing",
			"rewrite",
			"better version",
			"enhance text",
			"edit this",
		],
		pattern: "improve_writing",
		context: "technical_writer",
	},
	// Planning/Architecture
	{
		keywords: ["design", "architecture", "plan", "structure", "blueprint"],
		pattern: "create_design_document",
		strategy: "tot",
	},
	// Agile stories
	{
		keywords: [
			"feature",
			"agile",
			"sprint",
			"acceptance criteria",
			"story breakdown",
		],
		pattern: "agility_story",
	},
	// Research/Academic
	{
		keywords: [
			"paper",
			"research",
			"study",
			"academic",
			"journal",
			"citation",
		],
		pattern: "analyze_paper",
		strategy: "cot",
	},
	// Complex reasoning
	{
		keywords: [
			"complex",
			"difficult",
			"step by step",
			"think through",
			"reason about",
		],
		strategy: "cot",
	},
	// Creative brainstorming
	{
		keywords: [
			"brainstorm",
			"ideas",
			"creative",
			"alternatives",
			"options",
		],
		strategy: "tot",
	},
];

/**
 * Detects appropriate Fabric components from user message.
 */
function detectFabricComponents(message: string): {
	pattern?: string;
	context?: string;
	strategy?: string;
} {
	const lowerMessage = message.toLowerCase();
	const result: { pattern?: string; context?: string; strategy?: string } =
		{};

	for (const rule of TASK_DETECTION_RULES) {
		const matches = rule.keywords.some((kw) => lowerMessage.includes(kw));
		if (matches) {
			if (rule.pattern && !result.pattern) {
				result.pattern = rule.pattern;
			}
			if (rule.context && !result.context) {
				result.context = rule.context;
			}
			if (rule.strategy && !result.strategy) {
				result.strategy = rule.strategy;
			}
		}
	}

	return result;
}

// =============================================================================
// Main Enhancement Function
// =============================================================================

/**
 * Enhance a system prompt using Fabric AI's Strategy → Context → Pattern composition.
 *
 * This is the main function to use across the codebase for prompt enhancement.
 * It handles:
 * - Availability checking with caching
 * - Auto-detection of appropriate patterns based on user message
 * - Graceful fallback when Fabric AI is unavailable
 * - Component caching for performance
 *
 * @param options - Enhancement options
 * @returns Enhanced prompt result
 */
export async function enhancePromptWithFabric(
	options: FabricEnhanceOptions,
): Promise<FabricEnhanceResult> {
	const {
		userMessage,
		basePrompt = "",
		strategy: forceStrategy,
		context: forceContext,
		pattern: forcePattern,
		variables,
		gracefulFallback = true,
	} = options;

	const defaultResult: FabricEnhanceResult = {
		systemPrompt: basePrompt,
		components: { strategy: null, context: null, pattern: null },
		fabricUsed: false,
		fallbackUsed: false,
	};

	try {
		// Check availability first
		const available = await isFabricAvailable();
		if (!available) {
			if (gracefulFallback) {
				return { ...defaultResult, fallbackUsed: true };
			}
			throw new Error("Fabric AI server is not available");
		}

		// Detect components if not forced
		const detected = detectFabricComponents(userMessage);
		const strategy = forceStrategy || detected.strategy;
		const context = forceContext || detected.context;
		const pattern = forcePattern || detected.pattern;

		// If no components detected and none forced, return base prompt
		if (!strategy && !context && !pattern) {
			return { ...defaultResult, fabricUsed: true };
		}

		// Build composed prompt
		const parts: string[] = [];
		const components: FabricEnhanceResult["components"] = {
			strategy: null,
			context: null,
			pattern: null,
		};
		const cacheHits = { strategy: false, context: false, pattern: false };

		// 1. Add Strategy (controls reasoning methodology)
		if (strategy) {
			cacheHits.strategy = globalCache.getStrategy(strategy) !== null;
			const strategyData = await getStrategy(strategy);
			if (strategyData) {
				parts.push(strategyData.prompt);
				components.strategy = strategy;
			}
		}

		// 2. Add Context (controls identity/expertise)
		if (context) {
			cacheHits.context = globalCache.getContext(context) !== null;
			const contextData = await getContext(context);
			if (contextData) {
				parts.push(contextData.content);
				components.context = context;
			}
		}

		// 3. Add Pattern (controls task execution)
		if (pattern) {
			cacheHits.pattern = globalCache.getPattern(pattern) !== null;
			const patternData = await getPattern(pattern);
			if (patternData) {
				let patternContent = patternData.pattern;

				// Apply variables if provided
				if (variables) {
					for (const [key, value] of Object.entries(variables)) {
						patternContent = patternContent.replace(
							new RegExp(`{{${key}}}`, "g"),
							value,
						);
					}
				}

				parts.push(patternContent);
				components.pattern = pattern;
			}
		}

		// Compose final prompt
		let systemPrompt = parts.join("\n\n");

		// Prepend base prompt if provided
		if (basePrompt) {
			systemPrompt =
				basePrompt + (systemPrompt ? `\n\n${systemPrompt}` : "");
		}

		return {
			systemPrompt,
			components,
			fabricUsed: true,
			fallbackUsed: false,
			cacheHits,
		};
	} catch (error) {
		console.warn("[FabricPromptEnhancer] Enhancement failed:", error);
		if (gracefulFallback) {
			return { ...defaultResult, fallbackUsed: true };
		}
		throw error;
	}
}

/**
 * Clear the Fabric AI cache.
 * Useful for testing or when you want to force fresh data.
 */
export function clearFabricCache(): void {
	globalCache.clear();
}

// =============================================================================
// Convenience Presets
// =============================================================================

/** Pre-configured enhancement for code review tasks */
export async function enhanceForCodeReview(
	basePrompt: string,
	userMessage: string,
): Promise<FabricEnhanceResult> {
	return enhancePromptWithFabric({
		userMessage,
		basePrompt,
		pattern: "review_code",
		context: "senior_dev",
	});
}

/** Pre-configured enhancement for security analysis */
export async function enhanceForSecurityAnalysis(
	basePrompt: string,
	userMessage: string,
): Promise<FabricEnhanceResult> {
	return enhancePromptWithFabric({
		userMessage,
		basePrompt,
		pattern: "find_vulnerabilities",
		context: "security_expert",
		strategy: "cot",
	});
}

/** Pre-configured enhancement for summarization */
export async function enhanceForSummarization(
	basePrompt: string,
	userMessage: string,
): Promise<FabricEnhanceResult> {
	return enhancePromptWithFabric({
		userMessage,
		basePrompt,
		pattern: "summarize",
	});
}

/** Pre-configured enhancement for document generation */
export async function enhanceForDocumentGeneration(
	basePrompt: string,
	userMessage: string,
): Promise<FabricEnhanceResult> {
	return enhancePromptWithFabric({
		userMessage,
		basePrompt,
		pattern: "create_design_document",
		context: "technical_writer",
	});
}
