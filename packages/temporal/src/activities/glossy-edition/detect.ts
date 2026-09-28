import { putCacheEntry } from "@repo/database";
import { detectGlossyOpportunities } from "../../lib/glossy/detect-opportunities";
import { withHeartbeatTicker } from "../lib/activity-liveness";
import {
	GLOSSY_BUILD_LOG,
	type GlossyDetectionCacheOutput,
	type GlossyKeyedSection,
	glossyDetectionKey,
	glossyFailure,
	glossyModelContext,
	guardBuild,
	loadBuildSource,
	parseDetectionOutput,
	readGlossyCacheEntry,
	reservedKinds,
	stopSuperseded,
	withSourceErrors,
} from "./shared";
import type {
	DetectGlossyOpportunitiesActivityInput,
	DetectGlossyOpportunitiesActivityResult,
} from "./types";

/**
 * Visual-opportunity detection for a Glossy build (Fizzy #2589, R17, KTD8,
 * KTD9): one model call over the sections prepare chose — the whole document
 * on a first build, the changed sections on a rebuild — within the budget
 * prepare left.
 *
 * The cache comes first. The key covers the ordered section keys, the slots
 * in those sections, and the document type; the budget is not part of it, so
 * a hit is trimmed to the current limit. Only a completed detection is
 * cached, through the attempt guard; a degraded one returns no cache key and
 * builds without detected visuals. Finalize then leaves its sections out of
 * the edition's detection coverage, so the next build detects over them again.
 *
 * The result carries section keys and kinds. The reasons stay in the cache
 * row, where finalize reads them.
 */
export async function detectGlossyOpportunitiesActivity(
	input: DetectGlossyOpportunitiesActivityInput,
): Promise<DetectGlossyOpportunitiesActivityResult> {
	const source = await loadBuildSource(input, input.documentType);
	const wanted = new Set(input.sectionKeys);
	const considered = source.sections.filter((entry) => wanted.has(entry.key));
	const cacheKey = glossyDetectionKey(considered, input.documentType);

	await guardBuild(input.buildId, {
		step: "detecting",
		sectionsDone: input.progress.sectionsDone,
		sectionsTotal: input.progress.sectionsTotal,
	});

	const cached = await readGlossyCacheEntry({
		documentId: input.documentId,
		kind: "DETECTION",
		cacheKey,
	});
	const reused = cached === undefined ? null : parseDetectionOutput(cached);
	if (reused) {
		return {
			opportunities: withinBudget(reused, considered, input.limit),
			cacheKey,
			fromCache: true,
		};
	}

	const result = await withHeartbeatTicker(() =>
		detectGlossyOpportunities({
			...glossyModelContext(input),
			documentType: input.documentType,
			sections: considered.map(({ key, section }) => ({
				sectionKey: key,
				heading: section.heading,
				markdown: section.markdown,
				reservedKinds: [...reservedKinds(section)],
			})),
			limit: input.limit,
		}),
	);
	if (result.status === "aiProviderNotConfigured") {
		throw glossyFailure("AI_PROVIDER_NOT_CONFIGURED");
	}
	if (result.status === "degraded") {
		console.warn(`${GLOSSY_BUILD_LOG} Detection degraded`, {
			buildId: input.buildId,
			reason: result.reason,
		});
		return { opportunities: [], cacheKey: null, fromCache: false };
	}

	const output: GlossyDetectionCacheOutput = {
		opportunities: result.opportunities.map((opportunity) => ({
			sectionKey: opportunity.sectionKey,
			kind: opportunity.kind,
			reason: opportunity.reason,
		})),
	};
	const written = await withSourceErrors(() =>
		putCacheEntry({
			documentId: input.documentId,
			projectId: input.projectId,
			kind: "DETECTION",
			cacheKey,
			sectionKey: null,
			output,
			buildId: input.buildId,
		}),
	);
	if (written === "superseded") {
		return stopSuperseded(input.buildId);
	}
	return {
		opportunities: withinBudget(
			output.opportunities,
			considered,
			input.limit,
		),
		cacheKey,
		fromCache: false,
	};
}

/** One per considered section, none it reserves, at most `limit`, in document order. */
function withinBudget(
	opportunities: GlossyDetectionCacheOutput["opportunities"],
	considered: readonly GlossyKeyedSection[],
	limit: number,
): DetectGlossyOpportunitiesActivityResult["opportunities"] {
	const byKey = new Map(
		considered.map((entry, index) => [
			entry.key,
			{ index, reserved: reservedKinds(entry.section) },
		]),
	);
	const taken = new Set<string>();
	return opportunities
		.filter((opportunity) => {
			const section = byKey.get(opportunity.sectionKey);
			if (
				!section ||
				taken.has(opportunity.sectionKey) ||
				section.reserved.has(opportunity.kind)
			) {
				return false;
			}
			taken.add(opportunity.sectionKey);
			return true;
		})
		.sort(
			(a, b) =>
				(byKey.get(a.sectionKey)?.index ?? 0) -
				(byKey.get(b.sectionKey)?.index ?? 0),
		)
		.slice(0, Math.max(0, limit))
		.map(({ sectionKey, kind }) => ({ sectionKey, kind }));
}
