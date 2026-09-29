import { GLOSSY_PIPELINE_VERSION } from "@repo/agent-prompts/glossy";
import {
	db,
	finalizeGlossyBuild,
	type GlossyCacheKind,
	getCacheEntries,
	markGlossyBuildSuperseded,
	type Prisma,
	recordAudit,
} from "@repo/database";
import {
	type GlossyAnchor,
	type GlossySection,
	splitMarkdownBlocks,
} from "@repo/utils/glossy/cleanup";
import {
	type EditionAnchor,
	type EditionContent,
	type EditionReport,
	type EditionSection,
	type EditionVisual,
	editionContentSchema,
	GLOSSY_APPENDIX_SECTION_KEY,
} from "@repo/utils/glossy/edition-content";
import { computeMermaidVisualKey } from "@repo/utils/glossy/keys";
import { specHash, visualSpecSchema } from "@repo/utils/glossy/visual-spec";
import { planGlossyVisuals } from "./prepare-build";
import {
	GLOSSY_BUILD_LOG,
	type GlossyBuildSource,
	glossyDetectionKey,
	glossyExtractedVisualKey,
	glossyInconsistency,
	guardBuild,
	loadBuildSource,
	type NormalizedGlossyBuildOptions,
	normalizeBuildOptions,
	opportunityId,
	type PriorDetectedVisuals,
	parseDetectionOutput,
	parseExtractionOutput,
	parseRewriteOutput,
	readPriorDetectedVisuals,
	slotExtractKind,
	withSourceErrors,
} from "./shared";
import type {
	ExtractGlossyVisualActivityResult,
	FinalizeGlossyBuildActivityInput,
	FinalizeGlossyBuildActivityResult,
	GlossyKeptOriginalReason,
	GlossyVisualDropReason,
} from "./types";

/**
 * Last step of a Glossy build (Fizzy #2589, R6, R8, R16, R19, R21, R22, R30,
 * R43, KTD5, KTD6, KTD8, KTD15, AE8).
 *
 * Assembles the edition in document order from the attempt's own snapshot
 * and the cache rows the run wrote or reused:
 *  - each main-flow section, rewritten or in its cleaned original wording,
 *    with its anchors: the document's own images, existing Mermaid diagrams
 *    as `existing_mermaid` visuals, and filled slots at their block index —
 *    clamped to the rewrite's block count, the rule slot preservation uses —
 *    then the section's detected visual after its last block;
 *  - the appendix, the report (sections kept in original wording, dropped
 *    visuals, unfilled slots, unrecognized scaffolding), and the provenance
 *    line (R43).
 * The result must pass `editionContentSchema` before it is written. The U2
 * transaction then swaps it in, releases the claim, stamps the cache rows
 * this build used, and prunes the rest (KTD5, KTD8). `built` is audited only
 * when that write applied; a superseded run marks its own attempt and stops.
 *
 * A build that finds no visuals still publishes (AE8): the sections and
 * appendix stand on their own, the visual map is empty, and the empty report
 * is what tells editors no visuals were suggested.
 */
export async function finalizeGlossyBuildActivity(
	input: FinalizeGlossyBuildActivityInput,
): Promise<FinalizeGlossyBuildActivityResult> {
	// A retry after a finalize that applied and then lost its answer.
	const edition = await db.glossyEdition.findUnique({
		where: { documentId: input.documentId },
		select: {
			id: true,
			publishedBuildId: true,
			currentBuildId: true,
			contentRevision: true,
		},
	});
	if (
		edition?.publishedBuildId === input.buildId &&
		edition.currentBuildId !== input.buildId
	) {
		return {
			outcome: "applied",
			editionId: edition.id,
			contentRevision: edition.contentRevision,
		};
	}

	const source = await loadBuildSource(input, input.documentType);
	const sectionsTotal = source.sections.length;
	await guardBuild(input.buildId, {
		step: "finalizing",
		sectionsDone: sectionsTotal,
		sectionsTotal,
	});

	const options = normalizeBuildOptions(input.options);
	const now = new Date();
	const assembled = await assembleEdition(input, source, options, now);

	const parsed = editionContentSchema.safeParse(assembled.content);
	if (!parsed.success) {
		console.error(`${GLOSSY_BUILD_LOG} Assembled edition is invalid`, {
			buildId: input.buildId,
			issues: parsed.error.issues.slice(0, 10).map((issue) => ({
				code: issue.code,
				path: issue.path.join("."),
			})),
		});
		throw glossyInconsistency("The assembled Glossy edition is invalid");
	}
	const content = parsed.data;

	const result = await withSourceErrors(() =>
		finalizeGlossyBuild({
			buildId: input.buildId,
			content: toJson(content),
			report: toJson(content.report),
			// Decisions on appendix-only diagrams are filed under the appendix
			// key, which is no section's: keep them like a live section's (R29).
			sectionKeys: [
				...source.sections.map((entry) => entry.key),
				GLOSSY_APPENDIX_SECTION_KEY,
			],
			usedCacheKeys: assembled.usedCacheKeys,
			now,
		}),
	);
	if (result.outcome === "superseded") {
		await markGlossyBuildSuperseded(input.buildId);
		return { outcome: "superseded" };
	}

	const visualCount = Object.keys(content.visuals).length;
	recordAudit({
		action: "project.glossy_edition.built",
		category: "project",
		actor: { type: "user", userId: input.startedById },
		organizationId: input.organizationId,
		projectId: input.projectId,
		resource: { type: "project_document", id: input.documentId },
		metadata: {
			buildId: input.buildId,
			editionId: result.editionId,
			mode: content.mode,
			lengthMode: content.lengthMode,
			sourceVersion: content.provenance.sourceVersion,
			sections: content.sections.length,
			visuals: visualCount,
			keptOriginal: content.report.keptOriginal.length,
			droppedVisuals: content.report.droppedVisuals.length,
			unfilledSlots: content.report.unfilledSlots.length,
		},
	});
	console.info(`${GLOSSY_BUILD_LOG} Published`, {
		buildId: input.buildId,
		sections: content.sections.length,
		visuals: visualCount,
		keptOriginal: content.report.keptOriginal.length,
	});
	return {
		outcome: "applied",
		editionId: result.editionId,
		contentRevision: result.contentRevision,
	};
}

/** The edition content is JSON by construction; Prisma only needs to be told. */
function toJson(value: unknown): Prisma.InputJsonValue {
	return value as Prisma.InputJsonValue;
}

type UsedCacheKey = { kind: GlossyCacheKind; cacheKey: string };

/** Everything finalize writes, before validation. */
export async function assembleEdition(
	input: FinalizeGlossyBuildActivityInput,
	source: GlossyBuildSource,
	options: ReturnType<typeof normalizeBuildOptions>,
	now: Date,
): Promise<{ content: EditionContent; usedCacheKeys: UsedCacheKey[] }> {
	const rewriteKeys = input.rewrites.flatMap((rewrite) =>
		rewrite.outcome === "rewritten" ? [rewrite.cacheKey] : [],
	);
	const extractionKeys = input.visuals.flatMap((visual) =>
		visual.outcome === "extracted" ? [visual.cacheKey] : [],
	);
	// Detected reasons live in a detection row: this build's own, or for
	// Align first the whole-document detection the request ran (KTD10).
	const detectionKeys =
		options.mode === "align_first"
			? [glossyDetectionKey(source.sections, input.documentType)]
			: input.detectionCacheKey
				? [input.detectionCacheKey]
				: [];
	const [rewriteRows, extractionRows, detectionRows, prior] =
		await Promise.all([
			getCacheEntries({
				documentId: input.documentId,
				kind: "REWRITE",
				cacheKeys: [...new Set(rewriteKeys)],
			}),
			getCacheEntries({
				documentId: input.documentId,
				kind: "EXTRACTION",
				cacheKeys: [...new Set(extractionKeys)],
			}),
			getCacheEntries({
				documentId: input.documentId,
				kind: "DETECTION",
				cacheKeys: detectionKeys,
			}),
			options.mode === "roll_the_dice"
				? readPriorDetectedVisuals(input.documentId)
				: Promise.resolve(null),
		]);

	const used = new Map<string, UsedCacheKey>();
	const use = (kind: GlossyCacheKind, cacheKey: string) => {
		used.set(`${kind}:${cacheKey}`, { kind, cacheKey });
	};

	// Detection reasons: pinned ones from the published edition, the rest
	// from the detection rows. Plain text, at most 160 characters (KTD13).
	const reasons = new Map(prior?.reasons ?? []);
	for (const [cacheKey, output] of detectionRows) {
		const opportunities = parseDetectionOutput(output);
		if (!opportunities) {
			continue;
		}
		use("DETECTION", cacheKey);
		for (const opportunity of opportunities) {
			const id = opportunityId(opportunity.sectionKey, opportunity.kind);
			if (opportunity.reason && !reasons.get(id)) {
				reasons.set(id, opportunity.reason);
			}
		}
	}

	const report: EditionReport = {
		keptOriginal: [],
		droppedVisuals: [],
		unfilledSlots: [],
		scaffoldingUnrecognized: source.cleanup.scaffoldingUnrecognized,
		detectedSectionKeys: detectionCoverage(input, source, options, prior),
	};
	const visuals: Record<string, EditionVisual> = {};

	const rewrites = new Map(
		input.rewrites.map((rewrite) => [rewrite.sectionKey, rewrite]),
	);
	const slotResults = new Map<string, ExtractGlossyVisualActivityResult>();
	const detectedResults = new Map<
		string,
		ExtractGlossyVisualActivityResult[]
	>();
	for (const visual of input.visuals) {
		if (visual.slotId !== null) {
			slotResults.set(visual.visualKey, visual);
		} else {
			detectedResults.set(visual.sectionKey, [
				...(detectedResults.get(visual.sectionKey) ?? []),
				visual,
			]);
		}
	}

	/** The spec an extraction cached, or `null` when its row is gone or unreadable. */
	const extractedSpec = (result: ExtractGlossyVisualActivityResult) => {
		if (result.outcome !== "extracted") {
			return null;
		}
		const spec = parseExtractionOutput(extractionRows.get(result.cacheKey));
		if (spec) {
			use("EXTRACTION", result.cacheKey);
		}
		return spec;
	};

	const dropVisual = (
		kind: string,
		heading: string | null,
		reason: GlossyVisualDropReason,
	) => {
		report.droppedVisuals.push({ kind, heading, reason });
	};

	/** Images and existing diagrams, anywhere in the edition. */
	const staticAnchor = (
		anchor: Exclude<GlossyAnchor, { kind: "slot" }>,
		blockIndex: number,
		heading: string | null,
	): EditionAnchor | null => {
		if (anchor.kind === "image") {
			const { s3Key } = anchor;
			return { blockIndex, ref: { type: "image", s3Key } };
		}
		const spec = visualSpecSchema.safeParse({
			kind: "existing_mermaid",
			source: anchor.source,
		});
		if (!spec.success) {
			dropVisual("existing_mermaid", heading, "invalid_diagram");
			return null;
		}
		const visualKey = computeMermaidVisualKey({
			source: anchor.source,
			pipelineVersion: GLOSSY_PIPELINE_VERSION,
		});
		visuals[visualKey] = {
			kind: "existing_mermaid",
			spec: spec.data,
			specHash: specHash(spec.data),
			source: "existing_mermaid",
		};
		return { blockIndex, ref: { type: "visual", visualKey } };
	};

	const sections: EditionSection[] = [];
	for (const { key, section } of source.sections) {
		const text = sectionText(section, rewrites.get(key), rewriteRows);
		if (text.wording === "rewritten" && text.cacheKey) {
			use("REWRITE", text.cacheKey);
		}
		if (text.keptOriginalReason) {
			report.keptOriginal.push({
				heading: section.heading,
				reason: text.keptOriginalReason,
			});
		}
		const blockCount = splitMarkdownBlocks(text.markdown).length;
		const anchors: EditionAnchor[] = [];
		/** Kinds a filled slot shows here: a detected visual of the same kind yields to it. */
		const slotKinds = new Set<string>();
		const slotKeys = new Set<string>();

		for (const anchor of section.anchors) {
			const blockIndex = Math.min(anchor.blockIndex, blockCount);
			if (anchor.kind !== "slot") {
				const placed = staticAnchor(
					anchor,
					blockIndex,
					section.heading,
				);
				if (placed) {
					anchors.push(placed);
				}
				continue;
			}
			const visualKey = glossyExtractedVisualKey({
				sectionKey: key,
				slotId: anchor.slotId,
				kind: slotExtractKind(anchor.slotKind),
			});
			const result = slotKeys.has(visualKey)
				? undefined
				: slotResults.get(visualKey);
			slotKeys.add(visualKey);
			const spec = result ? extractedSpec(result) : null;
			if (!result || !spec) {
				report.unfilledSlots.push({
					slotId: anchor.slotId,
					reason:
						result?.outcome === "dropped"
							? result.reason
							: result
								? "visual_unavailable"
								: "slot_unavailable",
				});
				continue;
			}
			visuals[visualKey] = {
				kind: spec.kind,
				spec,
				specHash: specHash(spec),
				source: "slot",
			};
			slotKinds.add(spec.kind);
			anchors.push({ blockIndex, ref: { type: "visual", visualKey } });
		}

		for (const result of detectedResults.get(key) ?? []) {
			if (result.outcome === "dropped") {
				dropVisual(result.kind, section.heading, result.reason);
				continue;
			}
			const spec = extractedSpec(result);
			if (!spec) {
				dropVisual(result.kind, section.heading, "visual_unavailable");
				continue;
			}
			if (slotKinds.has(spec.kind)) {
				// A slot of this section already shows this kind (KTD9).
				continue;
			}
			const reason = reasons.get(opportunityId(key, result.kind));
			visuals[result.visualKey] = {
				kind: spec.kind,
				spec,
				specHash: specHash(spec),
				source: "detected",
				...(reason ? { reason } : {}),
			};
			anchors.push({
				blockIndex: blockCount,
				ref: { type: "visual", visualKey: result.visualKey },
			});
		}

		sections.push({
			sectionKey: key,
			headingPath: section.headingPath,
			heading: section.heading,
			level: section.level,
			markdown: text.markdown,
			wording: text.wording,
			...(text.keptOriginalReason
				? { keptOriginalReason: text.keptOriginalReason }
				: {}),
			anchors,
		});
	}

	const { appendix } = source.cleanup;
	const additionalMaterial = appendix.additionalMaterial.map((section) => {
		const blockCount = splitMarkdownBlocks(section.markdown).length;
		const anchors: EditionAnchor[] = [];
		for (const anchor of section.anchors) {
			if (anchor.kind === "slot") {
				// The appendix is cleaned but never rewritten or illustrated.
				report.unfilledSlots.push({
					slotId: anchor.slotId,
					reason: "appendix_slot",
				});
				continue;
			}
			const placed = staticAnchor(
				anchor,
				Math.min(anchor.blockIndex, blockCount),
				section.heading,
			);
			if (placed) {
				anchors.push(placed);
			}
		}
		return {
			heading: section.heading,
			level: section.level,
			markdown: section.markdown,
			anchors,
		};
	});

	const { snapshot } = source;
	const content: EditionContent = {
		// A header `Title:` names the edition ahead of the document's own
		// title, which is often the template's (Fizzy #2589 follow-up).
		title:
			source.cleanup.headerTitle?.trim() ||
			snapshot.title.trim() ||
			source.cleanup.title?.trim() ||
			"Glossy edition",
		pipelineVersion: GLOSSY_PIPELINE_VERSION,
		lengthMode: options.lengthMode,
		mode: options.mode,
		sections,
		visuals,
		appendix: {
			sources: appendix.sources,
			details: appendix.details,
			placeholders: appendix.placeholders,
			assumptions: appendix.assumptions,
			additionalMaterial,
		},
		report,
		provenance: {
			sourceTitle: snapshot.title,
			sourceVersion: snapshot.version,
			builtAt: now.toISOString(),
		},
	};
	return { content, usedCacheKeys: [...used.values()] };
}

/**
 * The sections whose detection this edition settles (KTD9), in document
 * order. A Roll-the-dice rebuild pins these and detects over the rest again.
 *
 * Align first covers every section: the editor aligned the whole document's
 * visuals, and a later Roll the dice keeps their choice.
 *
 * Roll the dice keeps the published edition's settled sections still in the
 * snapshot, and adds the sections this build's detection covered, re-planned
 * exactly as prepare planned them, from the same snapshot and the same
 * published edition (the claim keeps any other build from publishing
 * meanwhile). They count only when the detection completed: a degraded one
 * hands finalize no cache key. The key must also be the one those sections
 * produce, so a plan that somehow differs from prepare's records no section
 * no detection covered — its only cost is one more detection next build.
 */
function detectionCoverage(
	input: FinalizeGlossyBuildActivityInput,
	source: GlossyBuildSource,
	options: NormalizedGlossyBuildOptions,
	prior: PriorDetectedVisuals | null,
): string[] {
	const keys = source.sections.map((entry) => entry.key);
	if (options.mode === "align_first") {
		return keys;
	}
	const covered = new Set(prior?.sectionKeys);
	const planned = planGlossyVisuals({
		sections: source.sections,
		options,
		prior,
	}).detection;
	if (planned && input.detectionCacheKey !== null) {
		const considered = new Set(planned.sectionKeys);
		const detectionKey = glossyDetectionKey(
			source.sections.filter((entry) => considered.has(entry.key)),
			input.documentType,
		);
		if (detectionKey === input.detectionCacheKey) {
			for (const key of considered) {
				covered.add(key);
			}
		}
	}
	return keys.filter((key) => covered.has(key));
}

/** A section's final text: its cached rewrite, or the cleaned original with the reason. */
function sectionText(
	section: GlossySection,
	rewrite: FinalizeGlossyBuildActivityInput["rewrites"][number] | undefined,
	rewriteRows: Map<string, unknown>,
): {
	markdown: string;
	wording: EditionSection["wording"];
	keptOriginalReason?: GlossyKeptOriginalReason;
	cacheKey?: string;
} {
	if (rewrite?.outcome === "empty" || !section.markdown.trim()) {
		// Nothing to rewrite: the heading stands alone. Not "kept original".
		return { markdown: section.markdown, wording: "original" };
	}
	if (!rewrite) {
		return {
			markdown: section.markdown,
			wording: "original",
			keptOriginalReason: "rewrite_unavailable",
		};
	}
	if (rewrite.outcome === "keptOriginal") {
		return {
			markdown: section.markdown,
			wording: "original",
			keptOriginalReason: rewrite.reason,
		};
	}
	const markdown = parseRewriteOutput(rewriteRows.get(rewrite.cacheKey));
	if (markdown === null) {
		return {
			markdown: section.markdown,
			wording: "original",
			keptOriginalReason: "rewrite_unavailable",
		};
	}
	return { markdown, wording: "rewritten", cacheKey: rewrite.cacheKey };
}
