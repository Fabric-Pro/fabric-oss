import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { MODELS } from "@repo/database/prisma/ai-model-catalog";
import type { LanguageModelMiddleware } from "ai";
import type {
	ModelRequestObservation,
	RequestFingerprint,
	RequestPartShape,
} from "./request-shape";
import { estimateLanguageRequestInputTokens } from "./turn-budget-estimate";

type Identity = Pick<
	ModelRequestObservation,
	"iteration" | "activityAttempt" | "activityIdHash"
>;
interface Collection {
	identity: Identity;
	requests: ModelRequestObservation[];
	streamAttempt?: number;
	contextWindow?: number;
	additions?: {
		systemCharacters: number;
		callerToolNames: string[];
		skillToolNames?: string[];
	};
	extraInputTokens: number;
}
const collections = new AsyncLocalStorage<Collection>();
const physical = new AsyncLocalStorage<{
	collection: Collection;
	current: ModelRequestObservation;
	wireSends: number;
}>();
const json = (value: unknown) => JSON.stringify(value) ?? "";
const hash = (value: unknown) =>
	createHash("sha256").update(json(value)).digest("hex");

/** Avoid Buffer.toJSON and numeric-key expansion of typed arrays in diagnostic snapshots. */
function requestSnapshot(input: unknown) {
	const binarySizes = new WeakMap<object, number>();
	const seen = new WeakMap<object, unknown>();
	const visit = (value: unknown): unknown => {
		if (!value || typeof value !== "object") {
			return value;
		}
		if (seen.has(value)) {
			return seen.get(value);
		}
		const bytes = ArrayBuffer.isView(value)
			? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
			: value instanceof ArrayBuffer
				? new Uint8Array(value)
				: undefined;
		if (bytes) {
			const summary = {
				binaryBytes: bytes.byteLength,
				hash: createHash("sha256").update(bytes).digest("hex"),
			};
			seen.set(value, summary);
			binarySizes.set(summary, bytes.byteLength);
			return summary;
		}
		if ("toJSON" in value && typeof value.toJSON === "function") {
			return visit(value.toJSON());
		}
		const copy: Record<string, unknown> | unknown[] = Array.isArray(value)
			? []
			: {};
		seen.set(value, copy);
		let binaryBytes = 0;
		for (const [key, child] of Object.entries(value)) {
			const normalized = visit(child);
			Object.defineProperty(copy, key, {
				value: normalized,
				enumerable: true,
				writable: true,
				configurable: true,
			});
			if (normalized && typeof normalized === "object") {
				binaryBytes += binarySizes.get(normalized) ?? 0;
			}
		}
		binarySizes.set(copy, binaryBytes);
		return copy;
	};
	const value = visit(input);
	const part = (inner: unknown): RequestPartShape => {
		const serialized = json(inner);
		return {
			hash: createHash("sha256").update(serialized).digest("hex"),
			bytes:
				Buffer.byteLength(serialized, "utf8") +
				(inner && typeof inner === "object"
					? (binarySizes.get(inner) ?? 0)
					: 0),
		};
	};
	return { value, part };
}

export function hasActiveRequestObservation(): boolean {
	return collections.getStore() !== undefined;
}

export function requestModelContextWindow(
	modelId: string | undefined,
): number | undefined {
	if (!hasActiveRequestObservation()) {
		return undefined;
	}
	const model = MODELS.find(
		(entry) =>
			entry.canonicalName === modelId ||
			entry.providerMappings.some(
				(mapping) => mapping.providerModelId === modelId,
			),
	);
	return model && model.contextWindow > 0 ? model.contextWindow : undefined;
}

export function createRequestFingerprint(input: {
	modelId: unknown;
	route: unknown;
	prompt?: unknown;
	tools?: unknown;
	toolChoice?: unknown;
	sessionKey?: string;
	boundary?: "provider" | "wire";
}): RequestFingerprint {
	const snapshot = requestSnapshot(input);
	const request = snapshot.value as typeof input;
	const part = snapshot.part;
	const prompt = Array.isArray(request.prompt) ? request.prompt : [];
	const system: RequestPartShape[] = [];
	const messages: RequestPartShape[] = [];
	for (const message of prompt) {
		const role =
			message?.role ??
			(message?.type === "function_call_output"
				? "tool"
				: message?.type === "function_call" ||
						message?.type === "reasoning"
					? "assistant"
					: "other");
		if (role === "system") {
			system.push(part(message.content));
		} else {
			messages.push({
				...part(
					"content" in message
						? message.content
						: Object.fromEntries(
								Object.entries(message).filter(
									([key]) => key !== "role",
								),
							),
				),
				bytes: part(message).bytes,
				role: ["user", "assistant", "tool"].includes(role)
					? role
					: "other",
			});
		}
	}
	const cacheMarkers: number[][] = [];
	const hasMarker = (value: unknown): boolean => {
		if (!value || typeof value !== "object") {
			return false;
		}
		return Object.entries(value).some(
			([key, child]) =>
				key === "cacheControl" ||
				key === "cache_control" ||
				hasMarker(child),
		);
	};
	const tools = Array.isArray(request.tools) ? request.tools : [];
	for (const [index, tool] of tools.entries()) {
		if (hasMarker(tool?.providerOptions)) {
			cacheMarkers.push([0, index]);
		}
	}
	for (const [index, message] of prompt.entries()) {
		if (hasMarker(message?.providerOptions)) {
			cacheMarkers.push([1, index]);
		}
		for (const [partIndex, content] of (Array.isArray(message?.content)
			? message.content
			: []
		).entries()) {
			if (hasMarker(content?.providerOptions)) {
				cacheMarkers.push([1, index, partIndex]);
			}
		}
	}
	return {
		boundary: request.boundary ?? "provider",
		modelHash: hash(request.modelId),
		routeHash: hash(request.route),
		tools: (Array.isArray(request.tools) ? request.tools : []).map(part),
		system,
		messages,
		cacheMarkers,
		toolChoice: part(request.toolChoice),
		...(request.sessionKey !== undefined
			? { sessionKeyHash: hash(request.sessionKey) }
			: {}),
		bytes: part(request).bytes,
	};
}

export async function observeModelRequests<T>(
	identity: Identity,
	run: () => Promise<T>,
	onError?: (error: unknown, requests: ModelRequestObservation[]) => void,
): Promise<{
	result: T;
	requests: ModelRequestObservation[];
	extraInputTokens: number;
}> {
	const collection: Collection = {
		identity,
		requests: [],
		extraInputTokens: 0,
	};
	try {
		const result = await collections.run(collection, run);
		return {
			result,
			requests: collection.requests,
			extraInputTokens: collection.extraInputTokens,
		};
	} catch (error) {
		try {
			onError?.(error, collection.requests);
		} catch {
			/* Diagnostics do not replace the model failure. */
		}
		throw error;
	}
}
export function setRequestAdditions(additions: {
	systemCharacters: number;
	callerToolNames: string[];
	skillToolNames?: string[];
}): void {
	if (!hasActiveRequestObservation()) {
		return;
	}
	const collection = collections.getStore();
	if (collection) {
		collection.additions = additions;
	}
}
function recordAdditions(
	collection: Collection,
	params: { tools?: unknown },
): void {
	if (!collection.additions) {
		return;
	}
	const { systemCharacters, callerToolNames } = collection.additions;
	const tools = Array.isArray(params.tools)
		? params.tools.filter((tool) => !callerToolNames.includes(tool.name))
		: [];
	collection.extraInputTokens = Math.max(
		collection.extraInputTokens,
		Math.ceil((systemCharacters / 3) * 1.25) +
			estimateLanguageRequestInputTokens({ tools }) -
			64,
	);
}
function contextWindowFor(
	modelId: string | undefined,
	collectionWindow: number | undefined,
): number | undefined {
	const windows = [
		requestModelContextWindow(modelId),
		collectionWindow,
	].filter(
		(value): value is number => typeof value === "number" && value > 0,
	);
	return windows.length ? Math.min(...windows) : undefined;
}
export function setRequestContextWindow(
	contextWindow: number | undefined,
): void {
	if (!hasActiveRequestObservation()) {
		return;
	}
	const collection = collections.getStore();
	if (collection) {
		collection.contextWindow = contextWindow;
	}
}
export function setRequestStreamAttempt(attempt: number): void {
	if (!hasActiveRequestObservation()) {
		return;
	}
	const collection = collections.getStore();
	if (collection) {
		collection.streamAttempt = attempt;
	}
}

function counts(usage: unknown): Partial<ModelRequestObservation> {
	const u = (usage ?? {}) as Record<string, unknown>;
	const input = (
		u.inputTokens && typeof u.inputTokens === "object" ? u.inputTokens : {}
	) as Record<string, unknown>;
	const output = (
		u.outputTokens && typeof u.outputTokens === "object"
			? u.outputTokens
			: {}
	) as Record<string, unknown>;
	const details = (u.inputTokenDetails ?? {}) as Record<string, unknown>;
	const result: Partial<ModelRequestObservation> = {};
	const values = {
		inputTokens:
			typeof u.inputTokens === "number" ? u.inputTokens : input.total,
		outputTokens:
			typeof u.outputTokens === "number" ? u.outputTokens : output.total,
		cacheReadTokens: input.cacheRead ?? details.cacheReadTokens,
		cacheWriteTokens: input.cacheWrite ?? details.cacheWriteTokens,
		uncachedInputTokens: input.noCache ?? details.noCacheTokens,
	};
	for (const [key, value] of Object.entries(values)) {
		if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
			Object.assign(result, { [key]: value });
		}
	}
	return result;
}

/** Refine the active provider observation at the plan adapter's transformed fetch boundary. */
export function observeRequestWire(
	body: Record<string, unknown>,
	route: string,
	sessionKey: string | null,
): void {
	try {
		if (!hasActiveRequestObservation()) {
			return;
		}
		const context = physical.getStore();
		if (!context) {
			return;
		}
		if (context.wireSends++ > 0) {
			context.current = {
				...context.collection.identity,
				skillToolNames: context.current.skillToolNames,
				streamAttempt: context.collection.streamAttempt,
				request: context.collection.requests.length + 1,
				fingerprint: context.current.fingerprint,
				estimatedInputTokens: context.current.estimatedInputTokens,
				contextWindow: context.current.contextWindow,
			};
			context.collection.requests.push(context.current);
		}
		const prompt = [
			...(body.instructions
				? [{ role: "system", content: body.instructions }]
				: []),
			...(Array.isArray(body.input) ? body.input : []),
		];
		context.current.toolNames = requestToolNames(body.tools);
		context.current.fingerprint = createRequestFingerprint({
			modelId: body.model,
			route,
			prompt,
			tools: body.tools,
			toolChoice: body.tool_choice,
			sessionKey: sessionKey ?? undefined,
			boundary: "wire",
		});
		context.current.fingerprint.bytes = Buffer.byteLength(
			json(body),
			"utf8",
		);
		context.current.contextWindow = contextWindowFor(
			typeof body.model === "string" ? body.model : undefined,
			context.collection.contextWindow,
		);
		// Keep the provider-interface estimate: Responses wire parts have a different content shape.
	} catch {
		/* A wire diagnostic failure leaves the request untouched. */
	}
}

type PhysicalObservation = NonNullable<ReturnType<typeof physical.getStore>>;
function beginRequestObservation(
	params: { prompt?: unknown; tools?: unknown },
	model: { modelId: string; provider: string },
	route?: string,
): PhysicalObservation | undefined {
	try {
		if (!hasActiveRequestObservation()) {
			return undefined;
		}
		const collection = collections.getStore();
		if (!collection) {
			return undefined;
		}
		const current: ModelRequestObservation = {
			...collection.identity,
			toolNames: requestToolNames(params.tools),
			skillToolNames: collection.additions?.skillToolNames,
			streamAttempt: collection.streamAttempt,
			request: collection.requests.length + 1,
			fingerprint: createRequestFingerprint({
				modelId: model.modelId,
				route: { provider: model.provider, scope: route },
				...params,
			}),
			estimatedInputTokens: estimateLanguageRequestInputTokens(params),
			contextWindow: contextWindowFor(
				model.modelId,
				collection.contextWindow,
			),
		};
		recordAdditions(collection, params);
		collection.requests.push(current);
		return { collection, current, wireSends: 0 };
	} catch {
		return undefined;
	}
}
/** Installed inside request adapters. A missing or failed observation leaves the provider call intact. */
export function createRequestObservationMiddleware(
	route?: string,
): LanguageModelMiddleware {
	return {
		specificationVersion: "v4",
		wrapGenerate: async ({ doGenerate, params, model }) => {
			const context = beginRequestObservation(params, model, route);
			const result = context
				? await physical.run(context, doGenerate)
				: await doGenerate();
			if (context && hasActiveRequestObservation()) {
				try {
					Object.assign(context.current, counts(result.usage));
				} catch {
					/* Usage diagnostics are best effort. */
				}
			}
			return result;
		},
		wrapStream: async ({ doStream, params, model }) => {
			const context = beginRequestObservation(params, model, route);
			const result = context
				? await physical.run(context, doStream)
				: await doStream();
			if (!context || !hasActiveRequestObservation()) {
				return result;
			}
			try {
				return {
					...result,
					stream: result.stream.pipeThrough(
						new TransformStream({
							transform(chunk, controller) {
								try {
									if (
										hasActiveRequestObservation() &&
										chunk.type === "finish"
									) {
										Object.assign(
											context.current,
											counts(chunk.usage),
										);
									}
								} catch {
									/* Forward the original chunk if usage inspection fails. */
								}
								controller.enqueue(chunk);
							},
						}),
					),
				};
			} catch {
				return result;
			}
		},
	};
}

function requestToolNames(tools: unknown): string[] | undefined {
	if (!Array.isArray(tools)) {
		return [];
	}
	const names = tools.map((tool) => tool?.name ?? tool?.function?.name);
	return names.every((name) => typeof name === "string") ? names : undefined;
}
