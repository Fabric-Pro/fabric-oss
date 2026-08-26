/**
 * Auto-seed the maturation surfaces (Feature Maturation V2).
 *
 * Keeps Tab 1 in sync with the Clean Spec, called at discrete moments (editor
 * open, and right after the AI applies a run's changes). Best-effort.
 *
 *   - Summary: regenerated when the Clean Spec OR the bound Summary prompt has
 *     changed since the last generation (`lastSummaryHash`); no-ops otherwise (#4a).
 *   - Questions: extracted whenever the spec has CHANGED since the last
 *     extraction (`lastQuestionScanHash`). This is the key to robustness — the
 *     spec is rewritten by several paths (placeholder creation, the langgraph
 *     agent's `write_document_local`, the `enhanceFeature` fallback), and a
 *     content-hash gate surfaces a run's open questions regardless of WHICH path
 *     wrote them, while no-opping on an unchanged spec. Deduped against already
 *     open/answered questions, so re-extraction never resurfaces settled work.
 *
 * PM-sync isolation (§7.7): only writes `summaryDigest` / maturation surfaces,
 * never `description`/`acceptanceCriteria`, so it never triggers PM sync.
 */

import { createHash } from "node:crypto";
import {
	type FeatureMaturationState,
	type MaturationTenantFilter,
	setLastQuestionScanHash,
	setLastSummaryHash,
	setSummaryDigest,
} from "@repo/database";
import { combineCleanSpec } from "@repo/utils/clean-spec-content";
import { extractMaturationQuestions } from "./extract-maturation-questions";
import {
	generateMaturationSummary,
	resolveSummaryInstructions,
} from "./generate-summary-digest";

export interface SeedMaturationParams {
	feature: FeatureMaturationState;
	tenantFilter: MaturationTenantFilter;
}

export interface SeedMaturationResult {
	/** A Logic Summary digest was generated and written this run. */
	summaryGenerated: boolean;
	/** A question extraction ran this call (spec had changed since last scan). */
	questionsScanned: boolean;
	/** New question roots minted by that extraction (0 if none new). */
	minted: number;
}

const NO_OP: SeedMaturationResult = {
	summaryGenerated: false,
	questionsScanned: false,
	minted: 0,
};

function specHash(spec: string): string {
	return createHash("sha256").update(spec).digest("hex");
}

export async function seedMaturationSurfaces({
	feature,
	tenantFilter,
}: SeedMaturationParams): Promise<SeedMaturationResult> {
	const spec = combineCleanSpec(
		feature.description,
		feature.acceptanceCriteria,
	);
	// Nothing to derive from an empty Clean Spec (a brand-new placeholder with no
	// stub content yet).
	if (!spec.trim()) {
		return NO_OP;
	}

	// Summary regenerates when (Clean Spec + bound Summary prompt) changed since the
	// last generation — so it refreshes on a spec rebuild AND when the org edits the
	// Summary prompt, and no-ops otherwise (#4a). Falls back to generate-when-empty
	// if the gate somehow matches but no digest exists.
	let summaryGenerated = false;
	const summaryInstructions = await resolveSummaryInstructions({
		tenantFilter,
		storyKind: feature.kind === "BUG" ? "BUG" : "FEATURE",
	});
	const summaryHash = specHash(`${spec}\0${summaryInstructions}`);
	const needsSummary =
		summaryHash !== feature.lastSummaryHash ||
		!feature.summaryDigest?.trim();
	if (needsSummary) {
		const summary = await generateMaturationSummary({
			feature,
			tenantFilter,
			instructions: summaryInstructions,
		});
		if (summary) {
			await setSummaryDigest({
				userStoryId: feature.id,
				projectId: feature.projectId,
				summaryDigest: summary,
			});
			await setLastSummaryHash({
				userStoryId: feature.id,
				projectId: feature.projectId,
				hash: summaryHash,
			});
			summaryGenerated = true;
		}
	}

	// Extract questions only when the spec changed since the last extraction.
	// This is what makes question-surfacing robust across every write path and
	// cheap to call on open / after a run (no-op when nothing changed).
	const hash = specHash(spec);
	if (hash === feature.lastQuestionScanHash) {
		return { summaryGenerated, questionsScanned: false, minted: 0 };
	}

	const result = await extractMaturationQuestions({ feature, tenantFilter });
	await setLastQuestionScanHash({
		userStoryId: feature.id,
		projectId: feature.projectId,
		hash,
	});
	return { summaryGenerated, questionsScanned: true, minted: result.minted };
}
