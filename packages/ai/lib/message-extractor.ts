/**
 * LLM-based relevance extractor for raw integration messages.
 *
 * Compresses large raw-message payloads (Teams / Slack / etc.) into a small
 * set of relevance-ranked excerpts for a given query and optional stage
 * prompt. Designed to replace hard character caps at the integration
 * boundary — a char cap throws away information, the extractor throws away
 * *irrelevant* information.
 *
 * Resolves its model via the SIMPLE-task preference so org/user model
 * settings take effect — never hardcode a provider/model here.
 */

import { generateObject, zodSchema } from "ai";
import { z } from "zod";
import { getAIModelWithMetadata } from "./dynamic-model-selector";
import { logModelUsageAsync } from "./usage-logging";

/**
 * A raw message handed to the extractor. Only fields that are useful as
 * identity/citation metadata are typed — the `content` field is what gets
 * ranked.
 */
export interface RawExtractableMessage {
	messageId: string;
	from?: string;
	createdAt?: string;
	webLink?: string;
	/**
	 * The body text. HTML is tolerated — callers should pre-strip where
	 * possible, and we apply a defensive regex strip as belt-and-suspenders.
	 */
	content: string;
}

export interface ExtractRelevantExcerptsOptions {
	rawMessages: RawExtractableMessage[];
	query: string;
	/**
	 * The user's custom stage prompt (e.g. "Focus on acceptance criteria")
	 * used as a relevance lens in addition to the query.
	 */
	stagePrompt?: string;
	userId: string;
	organizationId?: string;
	projectId?: string;
	/** Max excerpts to return. Defaults to 8. */
	maxExcerpts?: number;
	/** Per-excerpt char cap. Defaults to 400. */
	maxCharsPerExcerpt?: number;
	/** Abort the LLM call after this many ms. Defaults to 15000. */
	timeoutMs?: number;
	/** Short label for logs ("search_messages" / "list_messages" / ...). */
	toolName?: string;
}

export interface RelevantExcerpt {
	messageId: string;
	from: string | null;
	createdAt: string | null;
	webLink: string | null;
	excerpt: string;
	/** 0..1 from the LLM, or null when the deterministic fallback ran. */
	relevance: number | null;
}

export interface ExtractRelevantExcerptsResult {
	excerpts: RelevantExcerpt[];
	totalScanned: number;
	returned: number;
	/** Ratio of raw content length to returned excerpt length. */
	compressionRatio: number;
	/** True when the deterministic fallback ran (timeout / error / bad JSON). */
	fallback: boolean;
	extractorLatencyMs: number;
}

const HTML_TAG_RE = /<[^>]*>/g;
const MULTI_SPACE_RE = /\s+/g;

function stripAndTrim(text: string): string {
	return text.replace(HTML_TAG_RE, " ").replace(MULTI_SPACE_RE, " ").trim();
}

function capAt(text: string, max: number): string {
	if (text.length <= max) {
		return text;
	}
	return `${text.slice(0, max).trimEnd()}…`;
}

function byCreatedAtDesc(
	a: RawExtractableMessage,
	b: RawExtractableMessage,
): number {
	const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
	const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
	return tb - ta;
}

function deterministicReduce(
	raw: RawExtractableMessage[],
	maxExcerpts: number,
	maxCharsPerExcerpt: number,
): RelevantExcerpt[] {
	return [...raw]
		.sort(byCreatedAtDesc)
		.slice(0, maxExcerpts)
		.map((m) => ({
			messageId: m.messageId,
			from: m.from ?? null,
			createdAt: m.createdAt ?? null,
			webLink: m.webLink ?? null,
			excerpt: capAt(stripAndTrim(m.content), maxCharsPerExcerpt),
			relevance: null,
		}));
}

const ExcerptSchema = z.object({
	messageId: z.string(),
	from: z.string().nullable().optional(),
	createdAt: z.string().nullable().optional(),
	webLink: z.string().nullable().optional(),
	excerpt: z.string(),
	relevance: z.number().min(0).max(1),
});

const ExtractionResultSchema = z.object({
	excerpts: z.array(ExcerptSchema).max(32),
});

function buildPrompt(params: {
	query: string;
	stagePrompt?: string;
	maxExcerpts: number;
	maxCharsPerExcerpt: number;
	messages: RawExtractableMessage[];
}): string {
	const { query, stagePrompt, maxExcerpts, maxCharsPerExcerpt, messages } =
		params;
	const stageLine = stagePrompt?.trim()
		? `Stage context (the user's custom prompt for this feature stage):\n${stagePrompt.trim()}\n\n`
		: "";

	const numbered = messages
		.map((m, i) => {
			const stripped = stripAndTrim(m.content);
			const head = capAt(stripped, 1600);
			return [
				`[#${i + 1}]`,
				`messageId: ${m.messageId}`,
				m.from ? `from: ${m.from}` : undefined,
				m.createdAt ? `createdAt: ${m.createdAt}` : undefined,
				m.webLink ? `webLink: ${m.webLink}` : undefined,
				`content: ${head}`,
			]
				.filter(Boolean)
				.join("\n");
		})
		.join("\n\n---\n\n");

	return [
		"You are filtering integration messages (e.g., Microsoft Teams) for relevance to a user task.",
		`Task query: ${query}`,
		stageLine,
		`Return at most ${maxExcerpts} excerpts. Each excerpt must be <= ${maxCharsPerExcerpt} characters.`,
		"Prefer excerpts that directly answer the query or inform the stage context.",
		"For each excerpt, echo the exact messageId so the caller can drill down.",
		"Score `relevance` between 0 and 1 (1 = perfect match).",
		"If no messages are relevant, return an empty excerpts array.",
		"",
		"Messages to consider:",
		"",
		numbered,
	].join("\n");
}

/**
 * Run the LLM extractor against a batch of raw messages.
 *
 * On timeout, parse failure, or provider error, falls back to a
 * deterministic reducer (top-N by recency, HTML-stripped, char-capped) so
 * the caller always gets a bounded, safe payload.
 */
export async function extractRelevantExcerpts(
	options: ExtractRelevantExcerptsOptions,
): Promise<ExtractRelevantExcerptsResult> {
	const {
		rawMessages,
		query,
		stagePrompt,
		userId,
		organizationId,
		projectId,
		maxExcerpts = 8,
		maxCharsPerExcerpt = 400,
		timeoutMs = 15_000,
		toolName = "extract",
	} = options;

	const totalScanned = rawMessages.length;
	const totalRawChars = rawMessages.reduce(
		(sum, m) => sum + (m.content?.length || 0),
		0,
	);
	const start = Date.now();

	if (rawMessages.length === 0) {
		return {
			excerpts: [],
			totalScanned: 0,
			returned: 0,
			compressionRatio: 0,
			fallback: false,
			extractorLatencyMs: 0,
		};
	}

	const buildDeterministicResult = (
		fallback: boolean,
	): ExtractRelevantExcerptsResult => {
		const excerpts = deterministicReduce(
			rawMessages,
			maxExcerpts,
			maxCharsPerExcerpt,
		);
		const returnedChars = excerpts.reduce(
			(s, e) => s + e.excerpt.length,
			0,
		);
		return {
			excerpts,
			totalScanned,
			returned: excerpts.length,
			compressionRatio:
				returnedChars === 0 ? 0 : totalRawChars / returnedChars,
			fallback,
			extractorLatencyMs: Date.now() - start,
		};
	};

	// Skip the LLM entirely when the raw payload already fits the excerpt
	// budget — no ranking value to add, and LLM calls cost latency + tokens.
	if (rawMessages.length <= maxExcerpts) {
		const fitsWithoutRanking = rawMessages.every(
			(m) => stripAndTrim(m.content || "").length <= maxCharsPerExcerpt,
		);
		if (fitsWithoutRanking) {
			return buildDeterministicResult(false);
		}
	}

	let model: Awaited<ReturnType<typeof getAIModelWithMetadata>>["model"];
	let metadata: Awaited<
		ReturnType<typeof getAIModelWithMetadata>
	>["metadata"];
	let trackUsage: Awaited<
		ReturnType<typeof getAIModelWithMetadata>
	>["trackUsage"];
	try {
		const resolved = await getAIModelWithMetadata(
			{ taskType: "SIMPLE" },
			{ userId, organizationId, projectId },
		);
		model = resolved.model;
		metadata = resolved.metadata;
		trackUsage = resolved.trackUsage;
	} catch (error) {
		console.warn(
			`[MessageExtractor:${toolName}] Model resolution failed; using deterministic fallback`,
			{ error: error instanceof Error ? error.message : String(error) },
		);
		return buildDeterministicResult(true);
	}

	const prompt = buildPrompt({
		query,
		stagePrompt,
		maxExcerpts,
		maxCharsPerExcerpt,
		messages: rawMessages,
	});

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const { object, usage } = await generateObject({
			model,
			schema: zodSchema(ExtractionResultSchema),
			prompt,
			abortSignal: controller.signal,
		});

		trackUsage();
		logModelUsageAsync({
			context: { userId, organizationId },
			metadata,
			taskType: "SIMPLE",
			usage,
			latencyMs: Date.now() - start,
			agentId: `message-extractor:${toolName}`,
			projectId,
		});

		// Normalize + defensively re-cap each excerpt.
		const knownIds = new Set(rawMessages.map((m) => m.messageId));
		const byId = new Map(rawMessages.map((m) => [m.messageId, m]));

		const normalized: RelevantExcerpt[] = [];
		for (const e of object.excerpts) {
			if (!knownIds.has(e.messageId)) {
				continue;
			}
			const src = byId.get(e.messageId);
			normalized.push({
				messageId: e.messageId,
				from: e.from ?? src?.from ?? null,
				createdAt: e.createdAt ?? src?.createdAt ?? null,
				webLink: e.webLink ?? src?.webLink ?? null,
				excerpt: capAt(stripAndTrim(e.excerpt), maxCharsPerExcerpt),
				relevance: e.relevance,
			});
			if (normalized.length >= maxExcerpts) {
				break;
			}
		}

		normalized.sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0));

		const returnedChars = normalized.reduce(
			(s, e) => s + e.excerpt.length,
			0,
		);
		const extractorLatencyMs = Date.now() - start;

		console.info(`[MessageExtractor:${toolName}] extracted`, {
			totalScanned,
			returned: normalized.length,
			compressionRatio:
				returnedChars === 0 ? 0 : totalRawChars / returnedChars,
			extractorLatencyMs,
		});

		return {
			excerpts: normalized,
			totalScanned,
			returned: normalized.length,
			compressionRatio:
				returnedChars === 0 ? 0 : totalRawChars / returnedChars,
			fallback: false,
			extractorLatencyMs,
		};
	} catch (error) {
		const aborted =
			error instanceof Error &&
			(error.name === "AbortError" ||
				/aborted|timeout/i.test(error.message));
		console.warn(
			`[MessageExtractor:${toolName}] extractor failed; using deterministic fallback`,
			{
				aborted,
				error: error instanceof Error ? error.message : String(error),
			},
		);
		return buildDeterministicResult(true);
	} finally {
		clearTimeout(timeout);
	}
}
