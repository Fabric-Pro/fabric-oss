/**
 * Fabric AI Integration for LangChain Agents
 *
 * Implements Fabric's Strategy → Context → Pattern composition model.
 * This is the same composition used by the Fabric CLI.
 *
 * Composition Order (all optional):
 * 1. STRATEGY - Controls reasoning methodology ("How should I think?")
 *    Examples: cot (Chain-of-Thought), tot (Tree-of-Thoughts), reflexion
 *
 * 2. CONTEXT - Controls identity/expertise ("Who am I?")
 *    Examples: security_expert, senior_dev, technical_writer
 *
 * 3. PATTERN - Controls task execution ("What should I do?")
 *    Examples: summarize, extract_wisdom, find_vulnerabilities
 *
 * Final System Message = <strategy>\n<context>\n<pattern>
 *
 * Usage:
 * ```typescript
 * import { composeFabricPrompt, FabricPromptComposer } from "@repo/agent-core";
 *
 * // One-shot composition
 * const prompt = await composeFabricPrompt({
 *   strategy: "cot",
 *   context: "security_expert",
 *   pattern: "find_vulnerabilities",
 * });
 *
 * // Reusable composer with caching
 * const composer = new FabricPromptComposer();
 * const prompt1 = await composer.compose({ pattern: "summarize" });
 * const prompt2 = await composer.compose({ pattern: "summarize" }); // cached
 * ```
 */

import http from "node:http";
import https from "node:https";

// ============================================================================
// Configuration
// ============================================================================

const FABRIC_AI_URL = process.env.FABRIC_AI_URL || "http://localhost:8080";
const FABRIC_AI_API_KEY = process.env.FABRIC_AI_API_KEY;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ============================================================================
// Types
// ============================================================================

export interface FabricStrategy {
	name: string;
	description: string;
	prompt: string;
}

export interface FabricContext {
	name: string;
	content: string;
}

export interface FabricPattern {
	name: string;
	pattern: string;
	description?: string;
}

export interface ComposeOptions {
	/** Strategy name for reasoning approach (e.g., "cot", "tot", "reflexion") */
	strategy?: string;
	/** Context name for persona/expertise (e.g., "security_expert", "senior_dev") */
	context?: string;
	/** Pattern name for task execution (e.g., "summarize", "find_vulnerabilities") */
	pattern?: string;
	/** Base prompt to prepend (agent's default system prompt) */
	basePrompt?: string;
	/** Variables to inject into the pattern (replaces {{varname}}) */
	variables?: Record<string, string>;
}

export interface ComposeResult {
	/** Fully composed system prompt */
	prompt: string;
	/** Components that were used */
	components: {
		strategy: string | null;
		context: string | null;
		pattern: string | null;
	};
	/** Whether Fabric AI was available */
	fabricAvailable: boolean;
	/** Cache hit info */
	cacheHits: {
		strategy: boolean;
		context: boolean;
		pattern: boolean;
	};
}

export interface DetectAndComposeOptions {
	/** User message to analyze for auto-detection */
	userMessage: string;
	/** Base prompt to include */
	basePrompt?: string;
	/** Force specific strategy (skips auto-detection) */
	strategy?: string;
	/** Force specific context (skips auto-detection) */
	context?: string;
	/** Force specific pattern (skips auto-detection) */
	pattern?: string;
}

// ============================================================================
// Cache Implementation
// ============================================================================

interface CacheEntry<T> {
	data: T;
	timestamp: number;
}

class FabricCache {
	private strategies = new Map<string, CacheEntry<FabricStrategy>>();
	private contexts = new Map<string, CacheEntry<FabricContext>>();
	private patterns = new Map<string, CacheEntry<FabricPattern>>();
	private patternList: CacheEntry<string[]> | null = null;
	private contextList: CacheEntry<string[]> | null = null;
	private strategyList: CacheEntry<FabricStrategy[]> | null = null;

	private isValid<T>(entry: CacheEntry<T> | null): entry is CacheEntry<T> {
		if (!entry) {
			return false;
		}
		return Date.now() - entry.timestamp < CACHE_TTL_MS;
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

	getPatternList(): string[] | null {
		return this.isValid(this.patternList) ? this.patternList.data : null;
	}

	setPatternList(data: string[]): void {
		this.patternList = { data, timestamp: Date.now() };
	}

	getContextList(): string[] | null {
		return this.isValid(this.contextList) ? this.contextList.data : null;
	}

	setContextList(data: string[]): void {
		this.contextList = { data, timestamp: Date.now() };
	}

	getStrategyList(): FabricStrategy[] | null {
		return this.isValid(this.strategyList) ? this.strategyList.data : null;
	}

	setStrategyList(data: FabricStrategy[]): void {
		this.strategyList = { data, timestamp: Date.now() };
	}

	clear(): void {
		this.strategies.clear();
		this.contexts.clear();
		this.patterns.clear();
		this.patternList = null;
		this.contextList = null;
		this.strategyList = null;
	}
}

// Global cache instance
const globalCache = new FabricCache();

// ============================================================================
// HTTP Client
// ============================================================================

async function fetchFabricJson<T>(path: string): Promise<T | null> {
	return new Promise((resolve) => {
		const url = `${FABRIC_AI_URL}${path}`;
		const parsedUrl = new URL(url);
		const client = parsedUrl.protocol === "https:" ? https : http;

		const headers: Record<string, string> = {
			Accept: "application/json",
		};
		if (FABRIC_AI_API_KEY) {
			headers["X-API-Key"] = FABRIC_AI_API_KEY;
		}

		const options = {
			hostname: parsedUrl.hostname,
			port:
				parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
			path: parsedUrl.pathname + parsedUrl.search,
			method: "GET",
			headers,
			timeout: 5000,
		};

		const req = client.request(options, (res) => {
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
		req.end();
	});
}

// ============================================================================
// Fabric AI API Functions
// ============================================================================

/** Check if Fabric AI server is available */
export async function isFabricAvailable(): Promise<boolean> {
	const health = await fetchFabricJson<{ status: string }>("/health");
	return health?.status === "healthy";
}

/** List all available patterns */
export async function listPatterns(): Promise<string[]> {
	const cached = globalCache.getPatternList();
	if (cached) {
		return cached;
	}

	const patterns = await fetchFabricJson<string[]>("/patterns/names");
	if (patterns) {
		globalCache.setPatternList(patterns);
	}
	return patterns || [];
}

/** List all available contexts */
export async function listContexts(): Promise<string[]> {
	const cached = globalCache.getContextList();
	if (cached) {
		return cached;
	}

	const contexts = await fetchFabricJson<string[]>("/contexts/names");
	if (contexts) {
		globalCache.setContextList(contexts);
	}
	return contexts || [];
}

/** List all available strategies */
export async function listStrategies(): Promise<FabricStrategy[]> {
	const cached = globalCache.getStrategyList();
	if (cached) {
		return cached;
	}

	const strategies = await fetchFabricJson<FabricStrategy[]>("/strategies");
	if (strategies) {
		globalCache.setStrategyList(strategies);
	}
	return strategies || [];
}

/** Get a specific pattern by name */
export async function getPattern(name: string): Promise<FabricPattern | null> {
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

/** Get a specific context by name */
export async function getContext(name: string): Promise<FabricContext | null> {
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

/** Get a specific strategy by name */
export async function getStrategy(
	name: string,
): Promise<FabricStrategy | null> {
	const cached = globalCache.getStrategy(name);
	if (cached) {
		return cached;
	}

	// Strategies come from list, find by name
	const strategies = await listStrategies();
	const strategy = strategies.find((s) => s.name === name);

	if (strategy) {
		globalCache.setStrategy(name, strategy);
		return strategy;
	}
	return null;
}

// ============================================================================
// Prompt Composition
// ============================================================================

/**
 * Composes a system prompt using Fabric's Strategy → Context → Pattern model.
 *
 * This is the core composition function that mirrors Fabric CLI behavior.
 * All three components are optional and compose in order:
 * 1. Strategy (reasoning approach)
 * 2. Context (persona/expertise)
 * 3. Pattern (task instructions)
 */
export async function composeFabricPrompt(
	options: ComposeOptions,
): Promise<ComposeResult> {
	const components: ComposeResult["components"] = {
		strategy: null,
		context: null,
		pattern: null,
	};
	const cacheHits: ComposeResult["cacheHits"] = {
		strategy: false,
		context: false,
		pattern: false,
	};

	const parts: string[] = [];

	// Check availability first
	const available = await isFabricAvailable();
	if (!available) {
		return {
			prompt: options.basePrompt || "",
			components,
			fabricAvailable: false,
			cacheHits,
		};
	}

	// 1. Add Strategy (controls reasoning methodology)
	if (options.strategy) {
		cacheHits.strategy = globalCache.getStrategy(options.strategy) !== null;
		const strategy = await getStrategy(options.strategy);
		if (strategy) {
			parts.push(strategy.prompt);
			components.strategy = options.strategy;
		}
	}

	// 2. Add Context (controls identity/expertise)
	if (options.context) {
		cacheHits.context = globalCache.getContext(options.context) !== null;
		const context = await getContext(options.context);
		if (context) {
			parts.push(context.content);
			components.context = options.context;
		}
	}

	// 3. Add Pattern (controls task execution)
	if (options.pattern) {
		cacheHits.pattern = globalCache.getPattern(options.pattern) !== null;
		const pattern = await getPattern(options.pattern);
		if (pattern) {
			let patternContent = pattern.pattern;

			// Apply variables if provided
			if (options.variables) {
				for (const [key, value] of Object.entries(options.variables)) {
					patternContent = patternContent.replace(
						new RegExp(`{{${key}}}`, "g"),
						value,
					);
				}
			}

			parts.push(patternContent);
			components.pattern = options.pattern;
		}
	}

	// Compose final prompt
	let prompt = parts.join("\n\n");

	// Prepend base prompt if provided
	if (options.basePrompt) {
		prompt = options.basePrompt + (prompt ? `\n\n${prompt}` : "");
	}

	return {
		prompt,
		components,
		fabricAvailable: true,
		cacheHits,
	};
}

// ============================================================================
// Auto-Detection
// ============================================================================

/** Task type detection rules */
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
		],
		pattern: "find_vulnerabilities",
		context: "security_expert",
		strategy: "cot",
	},
	// Code review
	{
		keywords: ["review code", "code review", "pr review", "pull request"],
		pattern: "review_code",
		context: "senior_dev",
	},
	// Code explanation
	{
		keywords: ["explain code", "what does this code", "how does this code"],
		pattern: "explain_code",
	},
	// Summarization
	{
		keywords: ["summarize", "summary", "tldr", "brief overview"],
		pattern: "summarize",
	},
	// Analysis
	{
		keywords: ["analyze", "analyse", "evaluate", "assess"],
		pattern: "analyze_claims",
		strategy: "cot",
	},
	// Extraction
	{
		keywords: ["extract", "find key", "identify main", "pull out"],
		pattern: "extract_wisdom",
	},
	// Writing improvement
	{
		keywords: [
			"improve writing",
			"rewrite",
			"better version",
			"enhance text",
		],
		pattern: "improve_writing",
		context: "technical_writer",
	},
	// Planning/Architecture
	{
		keywords: ["design", "architecture", "plan", "structure"],
		pattern: "create_design_document",
		strategy: "tot",
	},
	// Agile stories
	{
		keywords: ["feature", "agile", "sprint", "acceptance criteria"],
		pattern: "agility_story",
	},
	// Research
	{
		keywords: ["paper", "research", "study", "academic", "journal"],
		pattern: "analyze_paper",
	},
	// Complex reasoning (default strategy when uncertain)
	{
		keywords: ["complex", "difficult", "step by step", "think through"],
		strategy: "cot",
	},
];

/**
 * Detects appropriate Fabric components from user message.
 *
 * Returns suggested pattern, context, and strategy based on keywords.
 */
export function detectFabricComponents(message: string): {
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

/**
 * Auto-detects components from user message and composes prompt.
 *
 * This is the recommended function for dynamic prompt enhancement.
 */
export async function detectAndCompose(
	options: DetectAndComposeOptions,
): Promise<ComposeResult> {
	const detected = detectFabricComponents(options.userMessage);

	return composeFabricPrompt({
		basePrompt: options.basePrompt,
		strategy: options.strategy || detected.strategy,
		context: options.context || detected.context,
		pattern: options.pattern || detected.pattern,
	});
}

// ============================================================================
// Prompt Composer Class (for reuse with caching)
// ============================================================================

/**
 * Reusable Fabric prompt composer with built-in caching.
 *
 * Use this when making multiple composition calls in a session.
 * Caches are shared across instances via the global cache.
 */
export class FabricPromptComposer {
	/** Compose with explicit components */
	async compose(options: ComposeOptions): Promise<ComposeResult> {
		return composeFabricPrompt(options);
	}

	/** Auto-detect and compose based on user message */
	async detectAndCompose(
		options: DetectAndComposeOptions,
	): Promise<ComposeResult> {
		return detectAndCompose(options);
	}

	/** Check if Fabric AI is available */
	async isAvailable(): Promise<boolean> {
		return isFabricAvailable();
	}

	/** List available patterns */
	async listPatterns(): Promise<string[]> {
		return listPatterns();
	}

	/** List available contexts */
	async listContexts(): Promise<string[]> {
		return listContexts();
	}

	/** List available strategies */
	async listStrategies(): Promise<FabricStrategy[]> {
		return listStrategies();
	}

	/** Clear the cache (useful for testing or refresh) */
	clearCache(): void {
		globalCache.clear();
	}
}

// ============================================================================
// Convenience Constants
// ============================================================================

/** Common Fabric patterns */
export const FABRIC_PATTERNS = {
	// Analysis
	ANALYZE_CLAIMS: "analyze_claims",
	ANALYZE_ANSWERS: "analyze_answers",
	RATE_CONTENT: "rate_content",
	FIND_VULNERABILITIES: "find_vulnerabilities",

	// Extraction
	EXTRACT_WISDOM: "extract_wisdom",
	EXTRACT_MAIN_IDEA: "extract_main_idea",
	EXTRACT_INSIGHTS: "extract_insights",

	// Writing
	IMPROVE_WRITING: "improve_writing",
	SUMMARIZE: "summarize",

	// Code
	EXPLAIN_CODE: "explain_code",
	REVIEW_CODE: "review_code",
	IMPROVE_CODE: "improve_code",
	CODING_MASTER: "coding_master",

	// Planning
	AGILITY_STORY: "agility_story",
	CREATE_DESIGN_DOCUMENT: "create_design_document",
} as const;

/** Common Fabric contexts (personas) */
export const FABRIC_CONTEXTS = {
	SECURITY_EXPERT: "security_expert",
	SENIOR_DEV: "senior_dev",
	TECHNICAL_WRITER: "technical_writer",
	PRODUCT_MANAGER: "pm",
	DATA_SCIENTIST: "data_scientist",
} as const;

/** Common Fabric strategies (reasoning approaches) */
export const FABRIC_STRATEGIES = {
	/** Chain-of-Thought: Step-by-step reasoning */
	COT: "cot",
	/** Tree-of-Thoughts: Explore multiple reasoning paths */
	TOT: "tot",
	/** Reflexion: Self-reflection and correction */
	REFLEXION: "reflexion",
	/** ReAct: Reasoning + Action interleaved */
	REACT: "react",
} as const;

// ============================================================================
// Legacy Compatibility
// ============================================================================

// These exports maintain backward compatibility with the previous API

export type FabricPatternName =
	(typeof FABRIC_PATTERNS)[keyof typeof FABRIC_PATTERNS];

export interface EnhancePromptOptions {
	basePrompt: string;
	patternName?: string;
	taskMessage?: string;
	variables?: Record<string, string>;
	skipIfUnavailable?: boolean;
}

export interface EnhancePromptResult {
	prompt: string;
	patternUsed: string | null;
	fabricAvailable: boolean;
}

/** @deprecated Use composeFabricPrompt or detectAndCompose instead */
export async function enhancePromptWithFabricPattern(
	options: EnhancePromptOptions,
): Promise<EnhancePromptResult> {
	// If taskMessage provided, use auto-detection
	if (options.taskMessage) {
		const result = await detectAndCompose({
			userMessage: options.taskMessage,
			basePrompt: options.basePrompt,
			pattern: options.patternName,
		});
		return {
			prompt: result.prompt,
			patternUsed: result.components.pattern,
			fabricAvailable: result.fabricAvailable,
		};
	}

	// Otherwise, use explicit pattern only
	const result = await composeFabricPrompt({
		basePrompt: options.basePrompt,
		pattern: options.patternName,
		variables: options.variables,
	});

	return {
		prompt: result.prompt,
		patternUsed: result.components.pattern,
		fabricAvailable: result.fabricAvailable,
	};
}

/** @deprecated Use FabricPromptComposer methods instead */
export async function getFabricPattern(name: string) {
	return getPattern(name);
}

/** @deprecated Use listPatterns instead */
export async function listFabricPatterns(): Promise<string[]> {
	return listPatterns();
}

/** @deprecated Use composeFabricPrompt with specific presets */
export const AGENT_PATTERN_PRESETS = {
	codeReviewer: async (basePrompt: string) =>
		composeFabricPrompt({
			basePrompt,
			pattern: FABRIC_PATTERNS.REVIEW_CODE,
			context: FABRIC_CONTEXTS.SENIOR_DEV,
		}),
	documentWriter: async (basePrompt: string) =>
		composeFabricPrompt({
			basePrompt,
			pattern: FABRIC_PATTERNS.CREATE_DESIGN_DOCUMENT,
		}),
	summarizer: async (basePrompt: string) =>
		composeFabricPrompt({
			basePrompt,
			pattern: FABRIC_PATTERNS.SUMMARIZE,
		}),
	securityAnalyst: async (basePrompt: string) =>
		composeFabricPrompt({
			basePrompt,
			pattern: FABRIC_PATTERNS.FIND_VULNERABILITIES,
			context: FABRIC_CONTEXTS.SECURITY_EXPERT,
			strategy: FABRIC_STRATEGIES.COT,
		}),
};
