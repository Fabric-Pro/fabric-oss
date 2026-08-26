/**
 * AI node descriptions (R14), provider-agnostic via `@repo/ai` model resolution.
 * Modules are described in batches (technical + business registers + a smart
 * category); a single file can be described on demand. Every path degrades
 * gracefully — on a missing provider or a failed batch we return nothing and the
 * caller keeps the node's structural description, so analysis never hard-fails
 * on AI. Each module that carries an authoritative user note (B4) feeds it to
 * the model as ground truth so the AI builds on (never contradicts) the user.
 *
 * `describeModules` also returns accumulated token usage, the resolved model
 * name, and best-effort reasoning text so the workflow can persist analysis
 * telemetry (T3).
 */
import {
	AIProviderNotConfiguredError,
	generateObject,
	getAIModelWithMetadata,
} from "@repo/ai";
import { logger } from "@repo/logs";
import { z } from "zod";
import {
	addTokenTotals,
	concatReasoning,
	EMPTY_TOKEN_TOTALS,
	extractReasoningText,
	type TokenTotals,
	tokenTotalsFromUsage,
} from "./cost";
import {
	buildFileDescribePrompt,
	buildModuleDescribePrompt,
	type UserNotePrompt,
} from "./prompts";
import type { AtlasContext } from "./types";
import { recordAtlasUsage } from "./usage";

const DESCRIBE_TASK_TYPE = "SIMPLE" as const;
const MODULE_BATCH_SIZE = 6;
const MAX_SAMPLE_FILES = 6;
const MAX_SAMPLE_PREVIEW_CHARS = 600;
const MAX_FILE_PREVIEW_CHARS = 1500;

export interface ModuleDescribeInput {
	key: string;
	label: string;
	path: string | null;
	language: string | null;
	fileCount: number;
	loc: number;
	sampleFiles: { label: string; preview: string | null }[];
	dependsOn: string[];
	dependedOnBy: string[];
	/** Authoritative user override notes (B4) — fed as high-priority context. */
	userNote?: UserNotePrompt | null;
}

export interface NodeDescription {
	key: string;
	technical: string;
	business: string;
	/** AI-assigned category (one of the 7 keys, or a custom keyword). */
	category: string | null;
}

/** Accumulated telemetry returned alongside the descriptions (T3). */
export interface DescribeModulesResult {
	descriptions: NodeDescription[];
	usage: TokenTotals;
	/** Canonical model name that produced the descriptions, or null (no provider). */
	model: string | null;
	/** Best-effort concatenated reasoning text (B3), or null. */
	reasoning: string | null;
}

const batchSchema = z.object({
	descriptions: z.array(
		z.object({
			technical: z.string(),
			business: z.string(),
			// `category` is a free string (not an enum) so a custom keyword never
			// fails strict structured-output mode; the prompt steers the 7 keys.
			category: z.string(),
		}),
	),
});

function buildModulePrompt(modules: ModuleDescribeInput[]): string {
	return buildModuleDescribePrompt(modules, {
		maxSampleFiles: MAX_SAMPLE_FILES,
		maxSamplePreviewChars: MAX_SAMPLE_PREVIEW_CHARS,
	});
}

function normalizeCategory(value: string | null | undefined): string | null {
	const trimmed = value?.trim().toLowerCase();
	return trimmed ? trimmed : null;
}

async function resolveModel(ctx: AtlasContext) {
	try {
		return await getAIModelWithMetadata(
			{ taskType: DESCRIBE_TASK_TYPE },
			{
				userId: ctx.userId,
				organizationId: ctx.organizationId ?? undefined,
			},
		);
	} catch (error) {
		if (error instanceof AIProviderNotConfiguredError) {
			logger.warn("[atlas] no AI provider configured for describe");
			return null;
		}
		throw error;
	}
}

export async function describeModules(
	modules: ModuleDescribeInput[],
	ctx: AtlasContext,
	projectId?: string,
	onProgress?: () => void,
	/**
	 * Persist hook fired with each batch's descriptions as soon as the batch
	 * completes (resumability). Persisting per batch means a mid-run worker death
	 * only loses the in-flight batch (≤6 modules); a retry then skips
	 * already-described modules instead of re-running the whole AI pass.
	 */
	onBatchDescribed?: (batch: NodeDescription[]) => Promise<void>,
): Promise<DescribeModulesResult> {
	if (modules.length === 0) {
		return {
			descriptions: [],
			usage: EMPTY_TOKEN_TOTALS,
			model: null,
			reasoning: null,
		};
	}
	const resolution = await resolveModel(ctx);
	if (!resolution) {
		return {
			descriptions: [],
			usage: EMPTY_TOKEN_TOTALS,
			model: null,
			reasoning: null,
		};
	}
	const { model, metadata, trackUsage } = resolution;

	const results: NodeDescription[] = [];
	let usageTotals = EMPTY_TOKEN_TOTALS;
	let reasoning: string | null = null;
	for (let i = 0; i < modules.length; i += MODULE_BATCH_SIZE) {
		const batch = modules.slice(i, i + MODULE_BATCH_SIZE);
		const startedAt = Date.now();
		const batchDescriptions: NodeDescription[] = [];
		try {
			const result = await generateObject({
				model,
				schema: batchSchema,
				prompt: buildModulePrompt(batch),
			});
			const { object, usage } = result;
			recordAtlasUsage({
				ctx,
				metadata,
				taskType: DESCRIBE_TASK_TYPE,
				usage,
				startedAt,
				projectId,
			});
			usageTotals = addTokenTotals(
				usageTotals,
				tokenTotalsFromUsage(usage),
			);
			reasoning = concatReasoning(
				reasoning,
				extractReasoningText(result),
			);
			batch.forEach((m, j) => {
				const d = object.descriptions[j];
				if (d?.technical && d?.business) {
					batchDescriptions.push({
						key: m.key,
						technical: d.technical,
						business: d.business,
						category: normalizeCategory(d.category),
					});
				}
			});
		} catch (error) {
			logger.warn("[atlas] module describe batch failed", {
				error: error instanceof Error ? error.message : String(error),
				batchStart: i,
			});
		}
		results.push(...batchDescriptions);
		// Persist this batch OUTSIDE the AI try/catch: a DB write failure should
		// fail (and retry) the activity rather than be swallowed as a describe
		// failure. On retry the skip-filter excludes these now-persisted modules.
		if (batchDescriptions.length > 0) {
			await onBatchDescribed?.(batchDescriptions);
		}
		onProgress?.();
	}
	trackUsage();
	return {
		descriptions: results,
		usage: usageTotals,
		model: metadata?.canonicalName ?? null,
		reasoning,
	};
}

const fileSchema = z.object({
	technical: z.string(),
	business: z.string(),
	category: z.string(),
});

export interface FileDescribeInput {
	label: string;
	path: string;
	language: string | null;
	preview: string | null;
}

export async function describeFile(
	file: FileDescribeInput,
	ctx: AtlasContext,
	projectId?: string,
	/** Optional live instructions from the on-demand "Describe with AI" box. */
	instructions?: string,
): Promise<NodeDescription | null> {
	const resolution = await resolveModel(ctx);
	if (!resolution) {
		return null;
	}
	const prompt = buildFileDescribePrompt(
		{
			path: file.path,
			language: file.language,
			preview: file.preview,
		},
		{ maxPreviewChars: MAX_FILE_PREVIEW_CHARS, instructions },
	);
	const startedAt = Date.now();
	try {
		const { object, usage } = await generateObject({
			model: resolution.model,
			schema: fileSchema,
			prompt,
		});
		recordAtlasUsage({
			ctx,
			metadata: resolution.metadata,
			taskType: DESCRIBE_TASK_TYPE,
			usage,
			startedAt,
			projectId,
		});
		resolution.trackUsage();
		return {
			key: file.path,
			technical: object.technical,
			business: object.business,
			category: normalizeCategory(object.category),
		};
	} catch (error) {
		logger.warn("[atlas] file describe failed", {
			error: error instanceof Error ? error.message : String(error),
			path: file.path,
		});
		return null;
	}
}
