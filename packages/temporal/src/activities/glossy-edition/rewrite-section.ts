import { GLOSSY_PIPELINE_VERSION } from "@repo/agent-prompts/glossy";
import { putCacheEntry } from "@repo/database";
import { isKeySection } from "@repo/utils/glossy/fact-guard";
import { computeRewriteKey } from "@repo/utils/glossy/keys";
import { rewriteGlossySection } from "../../lib/glossy/rewrite-section";
import { withHeartbeatTicker } from "../lib/activity-liveness";
import {
	GLOSSY_BUILD_LOG,
	type GlossyRewriteCacheOutput,
	glossyFailure,
	glossyModelContext,
	guardBuild,
	loadBuildSource,
	normalizeBuildOptions,
	parseRewriteOutput,
	readGlossyCacheEntry,
	requireSection,
	stopSuperseded,
	withSourceErrors,
} from "./shared";
import type {
	RewriteGlossySectionActivityInput,
	RewriteGlossySectionActivityResult,
} from "./types";

/**
 * Executive rewrite of one section of a Glossy build (Fizzy #2589, R8, R14,
 * R16, KTD8, AE3).
 *
 * The attempt guard runs before anything else can spend a model call, then
 * the cache: the key is the section key, length mode, key-section class,
 * document type, and pipeline version, so an unchanged section of a rebuild
 * reuses its rewrite without a call. Only a guarded success is written back,
 * and only while this attempt holds the claim.
 *
 * A section that keeps its original wording is not cached — there is no
 * rewrite to reuse — and its guard findings are dropped here: they quote
 * document text, and results carry keys and reason codes only (KTD24).
 */
export async function rewriteGlossySectionActivity(
	input: RewriteGlossySectionActivityInput,
): Promise<RewriteGlossySectionActivityResult> {
	const source = await loadBuildSource(input, input.documentType);
	const { section } = requireSection(source, input.sectionKey);

	await guardBuild(input.buildId, {
		step: "rewriting",
		sectionsDone: input.progress.sectionsDone,
		sectionsTotal: input.progress.sectionsTotal,
	});

	if (!section.markdown.trim()) {
		return { sectionKey: input.sectionKey, outcome: "empty" };
	}
	const { lengthMode } = normalizeBuildOptions({
		mode: "roll_the_dice",
		lengthMode: input.lengthMode,
	});

	const cacheKey = computeRewriteKey({
		sectionKey: input.sectionKey,
		lengthMode,
		keySectionClass: isKeySection(section.headingPath) ? "key" : "standard",
		documentType: input.documentType,
		pipelineVersion: GLOSSY_PIPELINE_VERSION,
	});
	const cached = await readGlossyCacheEntry({
		documentId: input.documentId,
		kind: "REWRITE",
		cacheKey,
	});
	if (cached !== undefined && parseRewriteOutput(cached) !== null) {
		return {
			sectionKey: input.sectionKey,
			outcome: "rewritten",
			cacheKey,
			fromCache: true,
		};
	}

	const result = await withHeartbeatTicker(() =>
		rewriteGlossySection({
			...glossyModelContext(input),
			documentType: input.documentType,
			section,
			lengthMode,
		}),
	);
	switch (result.status) {
		case "aiProviderNotConfigured":
			throw glossyFailure("AI_PROVIDER_NOT_CONFIGURED");
		case "skipped":
			return { sectionKey: input.sectionKey, outcome: "empty" };
		case "keptOriginal":
			console.info(`${GLOSSY_BUILD_LOG} Section kept original wording`, {
				buildId: input.buildId,
				reason: result.reason,
				violations: result.violations.map(
					(violation) => violation.kind,
				),
			});
			return {
				sectionKey: input.sectionKey,
				outcome: "keptOriginal",
				reason:
					result.reason === "truncated" ? "truncated" : "fact_guard",
			};
		case "rewritten": {
			const output: GlossyRewriteCacheOutput = {
				markdown: result.markdown,
			};
			const written = await withSourceErrors(() =>
				putCacheEntry({
					documentId: input.documentId,
					projectId: input.projectId,
					kind: "REWRITE",
					cacheKey,
					sectionKey: input.sectionKey,
					output,
					buildId: input.buildId,
				}),
			);
			if (written === "superseded") {
				return stopSuperseded(input.buildId);
			}
			return {
				sectionKey: input.sectionKey,
				outcome: "rewritten",
				cacheKey,
				fromCache: false,
			};
		}
	}
}
