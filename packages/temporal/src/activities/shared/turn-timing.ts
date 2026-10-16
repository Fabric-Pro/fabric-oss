import { AsyncLocalStorage } from "node:async_hooks";

/** What speaking one sentence cost; times are milliseconds. */
export interface SpeechSentenceTiming {
	chars: number;
	route: "gateway" | "openai-direct" | "aura";
	/** When synthesis of this sentence began, after the speech request started. */
	startedAtMs: number;
	/** From that start to the first audio byte; the whole clip on a route that does not stream. */
	firstByteMs: number | null;
	/** From that start to the last audio byte. */
	totalMs: number | null;
}

/**
 * Wall-clock measurements for one spoken turn, collected where the work
 * happens and logged once as `turn.timing`. Keys ending in `Ms` are
 * milliseconds; the rest are token counts. Nothing here changes behavior: a
 * call outside a collected turn does nothing.
 */
export class TurnTimings {
	private readonly values = new Map<string, number>();
	private readonly speech: SpeechSentenceTiming[] = [];

	addSpeechSentence(sentence: SpeechSentenceTiming): void {
		this.speech.push(sentence);
	}

	set(name: string, value: number): void {
		this.values.set(name, value);
	}

	setOnce(name: string, value: number): void {
		if (!this.values.has(name)) {
			this.values.set(name, value);
		}
	}

	/** Runs `run` and records how long it took, whether it resolved or threw. */
	async time<T>(name: string, run: () => Promise<T>): Promise<T> {
		const startedAt = Date.now();
		try {
			return await run();
		} finally {
			this.set(name, Date.now() - startedAt);
		}
	}

	snapshot(): {
		values: Record<string, number>;
		speech: SpeechSentenceTiming[];
	} {
		return {
			values: Object.fromEntries(this.values),
			speech: [...this.speech],
		};
	}
}

const storage = new AsyncLocalStorage<TurnTimings>();

export function withTurnTimings<T>(
	timings: TurnTimings,
	run: () => Promise<T>,
): Promise<T> {
	return storage.run(timings, run);
}

export function recordTurnValue(name: string, value: number): void {
	storage.getStore()?.set(name, value);
}

export function recordTurnValueOnce(name: string, value: number): void {
	storage.getStore()?.setOnce(name, value);
}

export function recordTurnSpeechSentence(sentence: SpeechSentenceTiming): void {
	storage.getStore()?.addSpeechSentence(sentence);
}

export function timeTurnStep<T>(
	name: string,
	run: () => Promise<T>,
): Promise<T> {
	const timings = storage.getStore();
	return timings ? timings.time(name, run) : run();
}

/**
 * Records the token counts a model call reported. The AI SDK nests the
 * reasoning and cache-read counts under `outputTokenDetails` and
 * `inputTokenDetails`; a provider that does not report one leaves it out.
 */
export function recordTurnUsage(
	prefix: string,
	usage:
		| {
				inputTokens?: number;
				outputTokens?: number;
				inputTokenDetails?: { cacheReadTokens?: number };
				outputTokenDetails?: { reasoningTokens?: number };
		  }
		| undefined,
): void {
	if (!usage) {
		return;
	}
	const counts: Array<[string, number | undefined]> = [
		["inputTokens", usage.inputTokens],
		["outputTokens", usage.outputTokens],
		["reasoningTokens", usage.outputTokenDetails?.reasoningTokens],
		["cachedInputTokens", usage.inputTokenDetails?.cacheReadTokens],
	];
	for (const [name, value] of counts) {
		if (value !== undefined) {
			recordTurnValue(`${prefix}.${name}`, value);
		}
	}
}
