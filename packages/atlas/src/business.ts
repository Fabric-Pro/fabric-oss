/**
 * Business-mode derivation (D2): cluster technical modules into plain-language
 * BUSINESS CAPABILITIES via AI, with a deterministic fallback (group by
 * top-level path) so Business mode is never empty (E10).
 */
import {
	AIProviderNotConfiguredError,
	generateObject,
	getAIModelWithMetadata,
} from "@repo/ai";
import { logger } from "@repo/logs";
import { z } from "zod";
import {
	EMPTY_TOKEN_TOTALS,
	extractReasoningText,
	type TokenTotals,
	tokenTotalsFromUsage,
} from "./cost";
import { buildBusinessDerivationPrompt } from "./prompts";
import type { AtlasContext } from "./types";
import { recordAtlasUsage } from "./usage";

export interface ModuleSummary {
	key: string;
	label: string;
	path: string | null;
	/** business-register description from the describe step (or structural fallback). */
	business: string | null;
	/** Short excerpt of attached documentation (README/markdown) for this module. */
	doc?: string | null;
	/** Authoritative user note (B4) — the user's own description of this module. */
	userNote?: string | null;
}

interface BusinessCapability {
	key: string; // slug, unique within the analysis
	label: string;
	description: string;
	/** AI-assigned category (one of the 7 keys, or a custom keyword). */
	category: string | null;
	moduleKeys: string[];
}

interface BusinessRelation {
	sourceKey: string;
	targetKey: string;
}

export interface BusinessGraphDraft {
	capabilities: BusinessCapability[];
	relations: BusinessRelation[];
}

/** The derived business graph plus accumulated AI telemetry (T3). */
export interface BusinessDeriveResult {
	draft: BusinessGraphDraft;
	usage: TokenTotals;
	model: string | null;
	reasoning: string | null;
}

// NOTE: every field is REQUIRED (no `.optional()`). Azure/OpenAI structured
// output runs in strict JSON-schema mode, which demands that `required` lists
// every property — an optional field makes the whole request fail. The model
// returns an empty `relations` array when there are none.
const schema = z.object({
	capabilities: z.array(
		z.object({
			name: z.string(),
			description: z.string(),
			category: z.string(),
			moduleIndices: z.array(z.number()),
		}),
	),
	relations: z.array(z.object({ from: z.string(), to: z.string() })),
});

function slugify(input: string): string {
	return (
		input
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 60) || "capability"
	);
}

function buildPrompt(modules: ModuleSummary[]): string {
	return buildBusinessDerivationPrompt(modules);
}

function fallbackBusinessGraph(modules: ModuleSummary[]): BusinessGraphDraft {
	const groups = new Map<string, string[]>();
	for (const m of modules) {
		const top = (m.path ?? m.label).split("/")[0] || "core";
		const arr = groups.get(top) ?? [];
		arr.push(m.key);
		groups.set(top, arr);
	}
	const capabilities: BusinessCapability[] = [];
	const used = new Set<string>();
	for (const [top, moduleKeys] of groups) {
		let key = slugify(top);
		while (used.has(key)) {
			key = `${key}-x`;
		}
		used.add(key);
		capabilities.push({
			key,
			label: top,
			description: `Area derived from the "${top}" part of the codebase (${moduleKeys.length} module${
				moduleKeys.length === 1 ? "" : "s"
			}).`,
			category: null,
			moduleKeys,
		});
	}
	return { capabilities, relations: [] };
}

function normalizeCategory(value: string | null | undefined): string | null {
	const trimmed = value?.trim().toLowerCase();
	return trimmed ? trimmed : null;
}

function fallbackResult(modules: ModuleSummary[]): BusinessDeriveResult {
	return {
		draft: fallbackBusinessGraph(modules),
		usage: EMPTY_TOKEN_TOTALS,
		model: null,
		reasoning: null,
	};
}

export async function deriveBusinessGraph(
	modules: ModuleSummary[],
	ctx: AtlasContext,
	projectId?: string,
): Promise<BusinessDeriveResult> {
	if (modules.length === 0) {
		return {
			draft: { capabilities: [], relations: [] },
			usage: EMPTY_TOKEN_TOTALS,
			model: null,
			reasoning: null,
		};
	}

	let resolution: Awaited<ReturnType<typeof getAIModelWithMetadata>> | null;
	try {
		resolution = await getAIModelWithMetadata(
			{ taskType: "SIMPLE" },
			{
				userId: ctx.userId,
				organizationId: ctx.organizationId ?? undefined,
			},
		);
	} catch (error) {
		if (!(error instanceof AIProviderNotConfiguredError)) {
			logger.warn("[atlas] business model resolution error", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		return fallbackResult(modules);
	}

	const startedAt = Date.now();
	try {
		const result = await generateObject({
			model: resolution.model,
			schema,
			prompt: buildPrompt(modules),
		});
		const { object, usage } = result;
		recordAtlasUsage({
			ctx,
			metadata: resolution.metadata,
			taskType: "SIMPLE",
			usage,
			startedAt,
			projectId,
		});
		resolution.trackUsage();

		const capabilities: BusinessCapability[] = [];
		const usedSlugs = new Set<string>();
		const slugByName = new Map<string, string>();
		for (const cap of object.capabilities) {
			const moduleKeys = cap.moduleIndices
				.map((idx) => modules[idx]?.key)
				.filter((k): k is string => Boolean(k));
			if (moduleKeys.length === 0) {
				continue;
			}
			let key = slugify(cap.name);
			while (usedSlugs.has(key)) {
				key = `${key}-x`;
			}
			usedSlugs.add(key);
			slugByName.set(cap.name.toLowerCase(), key);
			capabilities.push({
				key,
				label: cap.name,
				description: cap.description,
				category: normalizeCategory(cap.category),
				moduleKeys,
			});
		}
		if (capabilities.length === 0) {
			return fallbackResult(modules);
		}

		const relations: BusinessRelation[] = [];
		const seen = new Set<string>();
		for (const r of object.relations ?? []) {
			const s = slugByName.get(r.from.toLowerCase());
			const t = slugByName.get(r.to.toLowerCase());
			if (s && t && s !== t && !seen.has(`${s}|${t}`)) {
				seen.add(`${s}|${t}`);
				relations.push({ sourceKey: s, targetKey: t });
			}
		}
		return {
			draft: { capabilities, relations },
			usage: tokenTotalsFromUsage(usage),
			model: resolution.metadata?.canonicalName ?? null,
			reasoning: extractReasoningText(result),
		};
	} catch (error) {
		logger.warn("[atlas] business derive failed; using fallback", {
			error: error instanceof Error ? error.message : String(error),
		});
		return fallbackResult(modules);
	}
}
