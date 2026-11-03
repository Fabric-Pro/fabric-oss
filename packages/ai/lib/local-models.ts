/**
 * Local-development models: a task (embeddings, decisions, images) is served
 * by an OpenAI-compatible server on the developer's machine — Ollama, LocalAI —
 * whatever provider the tenant configured.
 *
 * Each task is switched on separately, and only when `NODE_ENV` is exactly
 * "development" AND both `FABRIC_LOCAL_<TASK>_BASE_URL` and
 * `FABRIC_LOCAL_<TASK>_MODEL` are set. The Aspire AppHost sets them per local
 * provider a developer opts into in `.env.local` (`FABRIC_LOCAL_OLLAMA`,
 * `FABRIC_LOCAL_LOCALAI`); they can also point at a server run elsewhere.
 * Deployed environments run with `NODE_ENV=production` (and tests with "test"),
 * so there every task resolves as before even if the variables leak in.
 */
import { createOpenAI } from "@ai-sdk/openai";
import type {
	EmbeddingModel,
	Experimental_DecisionModel,
	LanguageModel,
} from "ai";

type DecisionModelInstance = Extract<
	Experimental_DecisionModel,
	{ doDecide: unknown }
>;
type DecideOptions = Parameters<DecisionModelInstance["doDecide"]>[0];
type DecideResult = Awaited<ReturnType<DecisionModelInstance["doDecide"]>>;
type DecisionQuestion = DecideOptions["questions"][string];
type DecisionAnswer = DecideResult["answers"][string];

export type LocalModelTask = "EMBEDDING" | "DECISION" | "IMAGE";

const ENV_PREFIX: Record<LocalModelTask, string> = {
	EMBEDDING: "FABRIC_LOCAL_EMBEDDINGS",
	DECISION: "FABRIC_LOCAL_DECISIONS",
	IMAGE: "FABRIC_LOCAL_IMAGES",
};

/**
 * Width of every Qdrant collection — `VECTOR_STORE_DIMENSIONS` in
 * `@repo/rag` (which depends on this package, so it cannot be imported here).
 */
const LOCAL_EMBEDDING_DIMENSIONS = 1536;

/** Selection source recorded for a locally served model. */
export const LOCAL_MODEL_SELECTION_SOURCE = "local_development";

/**
 * Stand-in credential. Local servers ignore it; it only satisfies the
 * "credentials present" checks the provider gates run.
 */
const LOCAL_API_KEY = "local-development";

export interface LocalModelConfig {
	/** OpenAI-compatible base URL, e.g. `http://localhost:11434/v1`. */
	baseUrl: string;
	/** Model served there, e.g. `qwen3-embedding:4b`. */
	model: string;
	/** Display name of the server, e.g. "Ollama"; "local server" when unset. */
	provider: string;
}

/**
 * The local override for one task, or null when it does not apply.
 */
export function getLocalModelConfig(
	task: LocalModelTask,
	env: NodeJS.ProcessEnv = process.env,
): LocalModelConfig | null {
	if (env.NODE_ENV !== "development") {
		return null;
	}
	const prefix = ENV_PREFIX[task];
	const baseUrl = env[`${prefix}_BASE_URL`]?.trim();
	const model = env[`${prefix}_MODEL`]?.trim();
	if (!baseUrl || !model) {
		return null;
	}
	let protocol: string;
	try {
		protocol = new URL(baseUrl).protocol;
	} catch {
		throw new Error(`${prefix}_BASE_URL is not a valid URL: "${baseUrl}"`);
	}
	if (protocol !== "http:" && protocol !== "https:") {
		throw new Error(
			`${prefix}_BASE_URL must be http(s), got "${protocol}"`,
		);
	}
	return {
		baseUrl: baseUrl.replace(/\/+$/, ""),
		model,
		provider: env[`${prefix}_PROVIDER`]?.trim() || "local server",
	};
}

/** {@link getLocalModelConfig} for EMBEDDING. */
export function getLocalEmbeddingsConfig(
	env: NodeJS.ProcessEnv = process.env,
): LocalModelConfig | null {
	return getLocalModelConfig("EMBEDDING", env);
}

/**
 * The override as a resolved config, in the shape `resolveModelWithProvider`
 * returns. The apiKey is a plaintext stand-in, so callers must not pass it
 * through `resolveProviderApiKey`.
 */
export function toLocalResolvedConfig(config: LocalModelConfig) {
	return {
		modelString: config.model,
		provider: "CUSTOM" as const,
		apiKey: LOCAL_API_KEY,
		clientId: null,
		encryptedClientSecret: null,
		baseUrl: config.baseUrl,
		configId: null,
		configSource: null,
		selectionSource: LOCAL_MODEL_SELECTION_SOURCE,
		canonicalName: config.model,
		deploymentName: null,
	};
}

/**
 * The embeddings override in the RAG provider-config shape returned by
 * `getEmbeddingRAGProviderConfig` / `getSystemEmbeddingRAGProviderConfig`.
 */
export function toLocalEmbeddingsRAGProviderConfig(config: LocalModelConfig) {
	return {
		apiKey: LOCAL_API_KEY,
		provider: "CUSTOM",
		baseUrl: config.baseUrl,
		enabledProviders: [] as string[],
		source: "environment" as const,
		deploymentName: null,
	};
}

function localProvider(
	config: LocalModelConfig,
	fetchImpl?: typeof fetch,
): ReturnType<typeof createOpenAI> {
	return createOpenAI({
		apiKey: LOCAL_API_KEY,
		baseURL: config.baseUrl,
		...(fetchImpl ? { fetch: fetchImpl } : {}),
	});
}

/**
 * Embedding model on the local server. Every request is sized to the vector
 * store's width: callers that pass no `dimensions` would otherwise get the
 * model's native size (2560 for qwen3-embedding:4b), which Qdrant refuses.
 */
export function getLocalEmbeddingModel(
	config: LocalModelConfig,
): EmbeddingModel {
	return localProvider(config, async (url, init) => {
		let body = init?.body;
		if (typeof body === "string") {
			try {
				body = JSON.stringify({
					...JSON.parse(body),
					dimensions: LOCAL_EMBEDDING_DIMENSIONS,
				});
			} catch {
				// Not JSON — send as is.
			}
		}
		return fetch(url, { ...init, body });
	}).embedding(config.model);
}

/**
 * Chat model on the local server, over Chat Completions — local servers do not
 * all implement the Responses API the OpenAI provider uses by default.
 */
export function getLocalLanguageModel(config: LocalModelConfig): LanguageModel {
	return localProvider(config).chat(config.model);
}

/**
 * Pixels a local image is drawn at: about 0.6 MP, which a 4B FLUX model draws
 * next to the local embedding model on an 8 GB GPU (1 MP does not fit).
 */
const LOCAL_IMAGE_AREA = 768 * 768;

/**
 * A size for the local image server: the requested `WxH` size, else the
 * `W:H` aspect ratio, else square — scaled to {@link LOCAL_IMAGE_AREA}, each
 * side a multiple of 64.
 */
export function localImageSize(options: {
	size?: string;
	aspectRatio?: string;
}): `${number}x${number}` {
	const match =
		options.size?.match(/^(\d+)x(\d+)$/) ??
		options.aspectRatio?.trim().match(/^(\d+):(\d+)$/);
	const width = match ? Number(match[1]) : 1;
	const height = match ? Number(match[2]) : 1;
	if (!(width > 0 && height > 0)) {
		return localImageSize({});
	}
	const scale = Math.sqrt(LOCAL_IMAGE_AREA / (width * height));
	const side = (value: number) =>
		Math.max(256, Math.round((value * scale) / 64) * 64);
	return `${side(width)}x${side(height)}`;
}

/** Image model on the local server (`/v1/images/generations`). */
export function getLocalImageModel(
	config: LocalModelConfig,
): ReturnType<ReturnType<typeof createOpenAI>["image"]> {
	return localProvider(config).image(config.model);
}

/** Option labels a decision question's options are shown under. */
const OPTION_LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** Floor for an option the model gave no probability, before normalizing. */
const MIN_OPTION_PROBABILITY = 1e-6;
const PROBABILITY_DECIMALS = 6;

function renderDecisionInput(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function renderDecisionState(state: DecideOptions["state"]): string {
	return state
		.map((part) => {
			if (part.type === "text") {
				return part.text;
			}
			if (part.type === "json") {
				return JSON.stringify(part.value, null, 2);
			}
			return "[attached file omitted]";
		})
		.join("\n\n");
}

/**
 * Asks one question and turns the logprobs of the single answer letter into a
 * distribution over the options. Null when no option letter was among them.
 */
async function decideOne(
	config: LocalModelConfig,
	stateText: string,
	question: DecisionQuestion,
	abortSignal: AbortSignal | undefined,
): Promise<{
	answer: DecisionAnswer;
	inputTokens: number;
	outputTokens: number;
}> {
	if (question.type === "score") {
		return { answer: { type: "refusal" }, inputTokens: 0, outputTokens: 0 };
	}
	const options: [string, unknown][] =
		question.type === "choice"
			? Object.entries(question.criteria)
			: [
					["true", question.criteria?.true ?? null],
					["false", question.criteria?.false ?? null],
				];
	if (options.length === 0 || options.length > OPTION_LABELS.length) {
		return { answer: { type: "refusal" }, inputTokens: 0, outputTokens: 0 };
	}
	const optionLines = options.map(([name, description], index) => {
		const detail =
			description === null || description === undefined
				? ""
				: `: ${renderDecisionInput(description)}`;
		return `${OPTION_LABELS[index]}) ${name}${detail}`;
	});

	const response = await fetch(`${config.baseUrl}/chat/completions`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${LOCAL_API_KEY}`,
		},
		signal: abortSignal,
		body: JSON.stringify({
			model: config.model,
			temperature: 0,
			max_tokens: 1,
			logprobs: true,
			top_logprobs: 20,
			messages: [
				{
					role: "system",
					content:
						"You answer one question about the state you are given. Reply with only the letter of the option that is correct.",
				},
				{
					role: "user",
					content: `State:\n${stateText}\n\nQuestion:\n${renderDecisionInput(question.instructions)}\n\nOptions:\n${optionLines.join("\n")}\n\nAnswer with one letter.`,
				},
			],
		}),
	});
	if (!response.ok) {
		throw new Error(
			`Local decision model ${config.model} failed: ${response.status} ${await response.text()}`,
		);
	}
	const body = (await response.json()) as {
		choices?: {
			logprobs?: {
				content?: {
					top_logprobs?: { token: string; logprob: number }[];
				}[];
			};
		}[];
		usage?: { prompt_tokens?: number; completion_tokens?: number };
	};
	const usage = {
		inputTokens: body.usage?.prompt_tokens ?? 0,
		outputTokens: body.usage?.completion_tokens ?? 0,
	};

	const mass = new Array<number>(options.length).fill(0);
	for (const candidate of body.choices?.[0]?.logprobs?.content?.[0]
		?.top_logprobs ?? []) {
		const label = candidate.token.replace(/[^A-Za-z]/g, "").toUpperCase();
		const index = label.length === 1 ? OPTION_LABELS.indexOf(label) : -1;
		if (index >= 0 && index < options.length) {
			mass[index] += Math.exp(candidate.logprob);
		}
	}
	if (mass.every((value) => value === 0)) {
		return { answer: { type: "refusal" }, ...usage };
	}
	const floored = mass.map((value) =>
		Math.max(value, MIN_OPTION_PROBABILITY),
	);
	const total = floored.reduce((sum, value) => sum + value, 0);
	const scale = 10 ** PROBABILITY_DECIMALS;
	const probabilities = floored.map(
		(value) => Math.round((value / total) * scale) / scale,
	);
	const best = probabilities.indexOf(Math.max(...probabilities));

	if (question.type === "boolean") {
		return {
			answer: { type: "boolean", probability: probabilities[0] },
			...usage,
		};
	}
	return {
		answer: {
			type: "choice",
			choice: options[best][0],
			probabilities: Object.fromEntries(
				options.map(([name], index) => [name, probabilities[index]]),
			),
		},
		...usage,
	};
}

/**
 * Decision model over the local server's chat model. The local servers have no
 * Decisions API, so each question is asked on its own and answered with one
 * option letter; the letter's token logprobs give the distribution the
 * callers' confidence thresholds read. Score questions are refused.
 */
export function getLocalDecisionModel(
	config: LocalModelConfig,
): DecisionModelInstance {
	return {
		specificationVersion: "v4",
		provider: `local.${config.provider.toLowerCase().replace(/\s+/g, "-")}`,
		modelId: config.model,
		supportedQuestionTypes: ["choice", "boolean"],
		async doDecide({ state, questions, abortSignal }) {
			const stateText = renderDecisionState(state);
			const answers: Record<string, DecisionAnswer> = {};
			let inputTokens = 0;
			let outputTokens = 0;
			for (const [id, question] of Object.entries(questions)) {
				const result = await decideOne(
					config,
					stateText,
					question,
					abortSignal,
				);
				answers[id] = result.answer;
				inputTokens += result.inputTokens;
				outputTokens += result.outputTokens;
			}
			return {
				answers,
				rounding: { probabilityDecimals: PROBABILITY_DECIMALS },
				usage: { inputTokens, outputTokens },
				warnings: [],
				response: { modelId: config.model, timestamp: new Date() },
			};
		},
	};
}
