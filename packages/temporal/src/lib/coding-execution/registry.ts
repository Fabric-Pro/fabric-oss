import type {
	CodingRunExecutionChannel,
	CodingRunProvider,
} from "@repo/database/prisma/generated/client";
import {
	BackgroundAgentsProvider,
	FabricBackgroundAdapter,
} from "./background-agents-provider";
import { env } from "./env";
import { RateLimitError } from "./errors";
import {
	KanbanLocalAdapter,
	LocalKanbanProvider,
} from "./local-kanban-provider";
import type { CodingExecutionProvider } from "./provider";

export interface CodingExecutionAdapterDefinition {
	provider: CodingRunProvider;
	executionChannel: CodingRunExecutionChannel;
	adapterName: "FabricBackgroundAdapter" | "KanbanLocalAdapter";
	requiresWorkingDirectory: boolean;
	create: () => CodingExecutionProvider;
}

/**
 * Rate limiter for local providers to prevent resource exhaustion
 */
class LocalProviderRateLimiter {
	private tokens: number;
	private lastRefill: number;
	private readonly maxTokens: number;
	private readonly refillIntervalMs: number;

	constructor(tokensPerInterval: number, intervalMs: number) {
		this.maxTokens = tokensPerInterval;
		this.tokens = tokensPerInterval;
		this.refillIntervalMs = intervalMs;
		this.lastRefill = Date.now();
	}

	private refill(): void {
		const now = Date.now();
		const elapsed = now - this.lastRefill;
		const tokensToAdd =
			Math.floor(elapsed / this.refillIntervalMs) * this.maxTokens;

		if (tokensToAdd > 0) {
			this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
			this.lastRefill = now;
		}
	}

	tryAcquire(): boolean {
		this.refill();
		if (this.tokens > 0) {
			this.tokens--;
			return true;
		}
		return false;
	}

	getTimeUntilNextTokenMs(): number {
		this.refill();
		if (this.tokens > 0) {
			return 0;
		}

		const now = Date.now();
		const elapsed = now - this.lastRefill;
		return this.refillIntervalMs - elapsed;
	}
}

// Global rate limiter instance
const localProviderRateLimiter = new LocalProviderRateLimiter(
	env.LOCAL_PROVIDER_RATE_LIMIT_PER_MINUTE,
	60_000, // 1 minute
);

const CODING_EXECUTION_ADAPTERS: Record<
	CodingRunProvider,
	CodingExecutionAdapterDefinition
> = {
	BACKGROUND_AGENTS: {
		provider: "BACKGROUND_AGENTS",
		executionChannel: "BACKGROUND_AGENTS",
		adapterName: "FabricBackgroundAdapter",
		requiresWorkingDirectory: false,
		create: () => new BackgroundAgentsProvider(),
	},
	KANBAN_LOCAL: {
		provider: "KANBAN_LOCAL",
		executionChannel: "LOCAL_AGENTS",
		adapterName: "KanbanLocalAdapter",
		requiresWorkingDirectory: true,
		create: () => new LocalKanbanProvider(),
	},
};

export function getCodingExecutionAdapterDefinition(
	provider: CodingRunProvider,
): CodingExecutionAdapterDefinition {
	const definition = CODING_EXECUTION_ADAPTERS[provider];
	if (!definition) {
		throw new Error(`Unknown provider: ${provider}`);
	}
	return definition;
}

export function listCodingExecutionAdapterDefinitions(): CodingExecutionAdapterDefinition[] {
	return Object.values(CODING_EXECUTION_ADAPTERS);
}

/**
 * Gets a coding execution provider with optional rate limiting for local providers
 * @throws {RateLimitError} If local provider rate limit is exceeded
 */
export function getCodingExecutionProvider(
	provider: CodingRunProvider,
): CodingExecutionProvider {
	// Apply rate limiting for local providers
	if (provider !== "BACKGROUND_AGENTS") {
		if (!localProviderRateLimiter.tryAcquire()) {
			const retryAfterMs =
				localProviderRateLimiter.getTimeUntilNextTokenMs();
			throw new RateLimitError(
				provider,
				`Local provider rate limit exceeded. Try again in ${Math.ceil(retryAfterMs / 1000)}s.`,
				retryAfterMs,
			);
		}
	}

	return getCodingExecutionAdapterDefinition(provider).create();
}

export function getBackgroundAgentsProvider(): FabricBackgroundAdapter {
	return new BackgroundAgentsProvider();
}

export { FabricBackgroundAdapter, KanbanLocalAdapter };
