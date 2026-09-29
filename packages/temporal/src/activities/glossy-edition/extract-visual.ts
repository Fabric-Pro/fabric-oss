import { putCacheEntry } from "@repo/database";
import { extractGlossyVisual } from "../../lib/glossy/extract-visual";
import { withHeartbeatTicker } from "../lib/activity-liveness";
import {
	findGlossySlot,
	GLOSSY_BUILD_LOG,
	type GlossyExtractionCacheOutput,
	glossyExtractedVisualKey,
	glossyExtractionTarget,
	glossyFailure,
	glossyModelContext,
	glossyVisualDropReason,
	guardBuild,
	loadBuildSource,
	parseExtractionOutput,
	readGlossyCacheEntry,
	requireSection,
	stopSuperseded,
	withSourceErrors,
} from "./shared";
import type {
	ExtractGlossyVisualActivityInput,
	ExtractGlossyVisualActivityResult,
} from "./types";

/**
 * Extract one visual of a Glossy build (Fizzy #2589, R18, R22, KTD8, AE3,
 * AE4): a slot, or a detected, pinned, or confirmed opportunity.
 *
 * The attempt guard runs before any model call, then the cache: the key is
 * the section key, the requested kind, the slot hint, the style direction,
 * the pipeline version, and a slot's own id (`glossyExtractionTarget`, which
 * single-visual regenerate keys its replacement with too), so an unchanged
 * section of a rebuild keeps its visual — a regenerated one included —
 * without a call, and two like slots in one section keep a visual each. Only
 * a spec that passed the label guard is cached, through the attempt guard. A
 * dropped visual carries its reason code to the report; the guard's findings
 * quote document text and stay here (KTD24).
 *
 * A slot's hint is read from the snapshot again rather than carried through
 * the workflow, so editor text never enters workflow history.
 */

export async function extractGlossyVisualActivity(
	input: ExtractGlossyVisualActivityInput,
): Promise<ExtractGlossyVisualActivityResult> {
	const source = await loadBuildSource(input, input.documentType);
	const { section } = requireSection(source, input.sectionKey);
	const visualKey = glossyExtractedVisualKey({
		sectionKey: input.sectionKey,
		slotId: input.slotId,
		kind: input.kind,
	});
	const base = {
		sectionKey: input.sectionKey,
		slotId: input.slotId,
		visualKey,
	};

	await guardBuild(input.buildId, {
		step: "visualizing",
		sectionsDone: input.progress.sectionsDone,
		sectionsTotal: input.progress.sectionsTotal,
	});

	let slotHint: string | null = null;
	if (input.slotId !== null) {
		const slot = findGlossySlot(section, input.slotId);
		if (!slot) {
			return {
				...base,
				outcome: "dropped",
				kind: input.kind,
				reason: "slot_unavailable",
			};
		}
		slotHint = slot.hint;
	}

	const { styleDirection, cacheKey } = glossyExtractionTarget({
		sectionKey: input.sectionKey,
		kind: input.kind,
		slotId: input.slotId,
		slotHint,
		styleDirection: input.styleDirection,
	});
	const cached = await readGlossyCacheEntry({
		documentId: input.documentId,
		kind: "EXTRACTION",
		cacheKey,
	});
	const reused = cached === undefined ? null : parseExtractionOutput(cached);
	if (reused && (input.kind === "auto" || reused.kind === input.kind)) {
		return {
			...base,
			outcome: "extracted",
			kind: reused.kind,
			cacheKey,
			fromCache: true,
		};
	}

	const result = await withHeartbeatTicker(() =>
		extractGlossyVisual({
			...glossyModelContext(input),
			documentType: input.documentType,
			section,
			kind: input.kind,
			slotHint,
			styleDirection,
			// A best-fit slot asks for `auto`, so only a slot's own flow is lenient.
			source: input.slotId !== null ? "slot" : "detected",
		}),
	);
	if (result.status === "aiProviderNotConfigured") {
		throw glossyFailure("AI_PROVIDER_NOT_CONFIGURED");
	}
	if (result.status === "dropped") {
		console.info(`${GLOSSY_BUILD_LOG} Visual dropped`, {
			buildId: input.buildId,
			kind: input.kind,
			slot: input.slotId !== null,
			reason: result.reason,
			violations: result.violations.map((violation) => violation.kind),
		});
		return {
			...base,
			outcome: "dropped",
			kind: input.kind,
			reason: glossyVisualDropReason(result.reason),
		};
	}

	const output: GlossyExtractionCacheOutput = { spec: result.spec };
	const written = await withSourceErrors(() =>
		putCacheEntry({
			documentId: input.documentId,
			projectId: input.projectId,
			kind: "EXTRACTION",
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
		...base,
		outcome: "extracted",
		kind: result.spec.kind,
		cacheKey,
		fromCache: false,
	};
}
