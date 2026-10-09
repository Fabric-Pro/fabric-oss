import {
	boundGlossyField,
	GLOSSY_MAX_OPPORTUNITIES,
	GLOSSY_STYLE_DIRECTION_MAX_CHARS,
	type GlossyDetectableKind,
} from "@repo/agent-prompts/glossy";
import { db, getDocumentStyle, getRecipientBrand } from "@repo/database";
import { parseOutline, scanFences } from "@repo/utils/glossy/outline";
import {
	deriveGlossyPalette,
	fillVisualColors,
	type GlossyPalette,
} from "@repo/utils/glossy/visual-colors";
import type { VisualSpec } from "@repo/utils/glossy/visual-spec";
import { visualSpecToMermaid } from "@repo/utils/glossy/visual-templates";
import {
	comparisonToMarkdownTable,
	insertVisuals,
	type SectionVisual,
	toMermaidFence,
} from "@repo/utils/proposal-artifact/visual-insert";
import { CancelledFailure } from "@temporalio/common";
import { detectGlossyOpportunities } from "../../lib/glossy/detect-opportunities";
import { extractGlossyVisual } from "../../lib/glossy/extract-visual";
import type { GlossyModelContext } from "../../lib/glossy/model";
import type {
	GenerateProposalVisualsInput,
	GenerateProposalVisualsResult,
} from "../../lib/proposal-artifact/types";
import {
	currentCancellationSignal,
	hasGlossyBodyText,
} from "../glossy-edition/shared";
import {
	currentActivityAttemptDeadline,
	withHeartbeatTicker,
} from "../lib/activity-liveness";
import { activityLogger } from "../lib/activity-logger";

/**
 * Visuals for a coordinated Proposal's Main document (Fizzy #2801).
 *
 * Runs between generation and the final save, so the visuals land in the
 * saved Main itself. Built from Glossy's flag-free library calls, not its
 * build activities (those are bound to `GlossyBuild` rows): one detection
 * over the Main sections, then one extraction per detected opportunity, each
 * fact-checked against its section by `extractGlossyVisual`. Timeline, flow
 * and org chart become ```` ```mermaid ```` fences with their colors filled
 * here; comparison becomes a markdown table; stat is not produced in this
 * release, so detection is told every section already shows one.
 *
 * Colors come from the document's Style and the project's recipient brand,
 * never the organization's brand kit; neither set gives the neutral palette.
 *
 * Fail-open: a failed extraction drops only its own visual, and any other
 * error, or a cancelled attempt, returns the content it was given, unchanged,
 * so the run saves Main without visuals. Each model call ticks a heartbeat; a
 * progress write after each step keeps the page's staleness clock moving.
 * The caller bounds the step to one attempt, so nothing here is retried.
 */
export async function generateProposalVisuals(
	input: GenerateProposalVisualsInput,
): Promise<GenerateProposalVisualsResult> {
	const unchanged: GenerateProposalVisualsResult = {
		content: input.content,
		insertedCount: 0,
	};
	const ids = {
		projectId: input.projectId,
		documentId: input.documentId,
		liveRunId: input.liveRunId,
	};

	try {
		const sections = proposalVisualSections(input.content);
		if (sections.length === 0) {
			return unchanged;
		}

		await reportVisualProgress(input, VISUALS_PROGRESS_START);
		const [style, recipientBrand] = await Promise.all([
			getDocumentStyle({
				documentId: input.documentId,
				organizationId: input.organizationId,
			}),
			getRecipientBrand(input.projectId),
		]);
		const palette = proposalVisualPalette({
			primaryColor: style?.primaryColor ?? null,
			accentColors: style?.accentColors ?? null,
			// The brand row is project-level; it is used only when it is in
			// the same organization as the run.
			recipientColors:
				recipientBrand?.organizationId === input.organizationId
					? recipientBrand.colors
					: null,
		});
		const styleDirection = boundGlossyField(
			style?.styleDirection,
			GLOSSY_STYLE_DIRECTION_MAX_CHARS,
		);
		const model: GlossyModelContext = {
			userId: input.userId,
			organizationId: input.organizationId,
			projectId: input.projectId,
			featureKey: PROPOSAL_VISUALS_FEATURE_KEY,
			planEligible: input.planEligible,
			abortSignal: currentCancellationSignal(),
		};

		const detection = await withHeartbeatTicker(() =>
			detectGlossyOpportunities({
				...model,
				documentType: "PROPOSAL",
				sections: sections.map((section) => ({
					sectionKey: section.key,
					heading: section.heading,
					markdown: section.markdown,
					reservedKinds: NOT_PRODUCED_KINDS,
				})),
				limit: GLOSSY_MAX_OPPORTUNITIES,
			}),
		);
		if (detection.status !== "detected") {
			activityLogger.info("Proposal visuals skipped", {
				...ids,
				reason: detection.status,
			});
			return unchanged;
		}
		const bySectionKey = new Map(
			sections.map((section) => [section.key, section]),
		);
		const wanted = detection.opportunities.filter(
			(opportunity) =>
				!NOT_PRODUCED_KINDS.includes(opportunity.kind) &&
				bySectionKey.has(opportunity.sectionKey),
		);
		await reportVisualProgress(input, VISUALS_PROGRESS_DETECTED);

		const deadline = currentActivityAttemptDeadline();
		const visuals: Array<SectionVisual | null> = new Array(
			wanted.length,
		).fill(null);
		let done = 0;
		let dropped = 0;
		let providerMissing = false;
		await forEachWithConcurrency(
			wanted,
			EXTRACTION_CONCURRENCY,
			async (opportunity, index) => {
				if (providerMissing || pastDeadline(deadline)) {
					return;
				}
				const section = bySectionKey.get(opportunity.sectionKey);
				if (!section) {
					return;
				}
				let markdown: string | null = null;
				try {
					const result = await withHeartbeatTicker(() =>
						extractGlossyVisual({
							...model,
							documentType: "PROPOSAL",
							section: {
								heading: section.heading,
								markdown: section.markdown,
							},
							kind: opportunity.kind,
							styleDirection,
							source: "detected",
						}),
					);
					if (result.status === "aiProviderNotConfigured") {
						providerMissing = true;
						return;
					}
					markdown =
						result.status === "extracted"
							? renderProposalVisual(result.spec, palette)
							: null;
				} catch (error) {
					// A cancelled attempt stops here: no new extraction
					// starts, and the step fails open below.
					if (isCancellation(error, model.abortSignal)) {
						throw error;
					}
					// Anything else (a provider error, a spec that does not
					// render) costs only this visual; the others still go in.
					activityLogger.warn(
						"Proposal visual extraction failed; dropped",
						{
							...ids,
							kind: opportunity.kind,
							errorName:
								error instanceof Error
									? error.name
									: typeof error,
						},
					);
				}
				if (markdown) {
					visuals[index] = {
						headingPath: section.headingPath,
						occurrenceIndex: section.occurrenceIndex,
						markdown,
					};
				} else {
					dropped += 1;
				}
				done += 1;
				await reportVisualProgress(
					input,
					VISUALS_PROGRESS_DETECTED +
						Math.round(
							((VISUALS_PROGRESS_END -
								VISUALS_PROGRESS_DETECTED) *
								done) /
								wanted.length,
						),
				);
			},
		);

		const placed = insertVisuals(
			input.content,
			visuals.filter(
				(visual): visual is SectionVisual => visual !== null,
			),
		);
		activityLogger.info("Proposal visuals generated", {
			...ids,
			sections: sections.length,
			detected: wanted.length,
			dropped,
			inserted: placed.inserted,
			skipped: placed.skipped,
			unmatched: placed.unmatched,
			providerMissing,
		});
		if (placed.inserted === 0) {
			return unchanged;
		}
		return { content: placed.markdown, insertedCount: placed.inserted };
	} catch (error) {
		activityLogger.warn(
			"Proposal visuals failed; saving Main without them",
			{
				...ids,
				errorName: error instanceof Error ? error.name : typeof error,
			},
		);
		return unchanged;
	}
}

/** Usage of every visuals model call is attributed here, not to Glossy. */
const PROPOSAL_VISUALS_FEATURE_KEY = "proposal-visuals";

/**
 * Kinds this release does not produce. Detection is told every section
 * already shows them, and anything detected anyway is dropped.
 */
const NOT_PRODUCED_KINDS: readonly GlossyDetectableKind[] = ["stat"];

/** Extractions in flight at once: fast enough, and gentle on the provider. */
const EXTRACTION_CONCURRENCY = 3;

/** No extraction starts with less than this left before the attempt's deadline. */
const EXTRACTION_RESERVE_MS = 45_000;

/** Progress written while visuals run; generation reports 80 before them. */
const VISUALS_PROGRESS_START = 82;
const VISUALS_PROGRESS_DETECTED = 84;
const VISUALS_PROGRESS_END = 90;

/** An opening fence whose info string names mermaid. */
const MERMAID_OPEN = /^ {0,3}(?:`{3,}|~{3,})[ \t]*mermaid(?:[\s{]|$)/i;

interface ProposalVisualSection {
	/** Caller-local key the detection call names the section by. */
	key: string;
	/** `parseOutline`'s full anchor path, as `insertVisuals` matches it. */
	headingPath: string[];
	occurrenceIndex: number;
	/** The heading's text as written. */
	heading: string;
	/** The section's own body: up to the next heading of any level. */
	markdown: string;
}

/**
 * The sections a visual may go into: every heading below a leading `#`
 * title, with its own body (subsections excluded, as `insertVisuals` places
 * a visual within a section's own content). A section without body text of
 * its own, or whose own body already holds a mermaid diagram, is left out,
 * since it would get no visual.
 */
function proposalVisualSections(content: string): ProposalVisualSection[] {
	const lines = content.split("\n");
	const fences = scanFences(lines);
	const outline = parseOutline(content);
	const sections: ProposalVisualSection[] = [];

	outline.forEach((heading, index) => {
		if (index === 0 && heading.level === 1) {
			return;
		}
		// `startLine` is 1-based, so it is also the 0-based index of the line
		// after the heading.
		const bodyStart = heading.startLine;
		const bodyEnd = (outline[index + 1]?.startLine ?? lines.length + 1) - 1;
		let hasMermaid = false;
		for (let line = bodyStart; line < bodyEnd; line++) {
			if (fences[line] === "open" && MERMAID_OPEN.test(lines[line])) {
				hasMermaid = true;
				break;
			}
		}
		const markdown = lines.slice(bodyStart, bodyEnd).join("\n").trim();
		if (hasMermaid || !hasGlossyBodyText({ markdown })) {
			return;
		}
		sections.push({
			key: `section-${index}`,
			headingPath: heading.headingPath,
			occurrenceIndex: heading.occurrenceIndex,
			heading: heading.text,
			markdown,
		});
	});
	return sections;
}

/**
 * The palette from the document's Style and the recipient brand only. A
 * Style primary color leads, then the Style accents, then the recipient's
 * colors; with none of them, the neutral palette.
 */
function proposalVisualPalette(input: {
	primaryColor: string | null;
	accentColors: readonly string[] | null;
	recipientColors: readonly string[] | null;
}): GlossyPalette {
	return deriveGlossyPalette({
		overrides: {
			primary: input.primaryColor,
			accents: input.accentColors,
		},
		recipientColors: input.recipientColors,
	});
}

/**
 * One extracted spec as the markdown block it becomes in Main, colors
 * filled, or null for a kind this release does not produce.
 */
function renderProposalVisual(
	spec: VisualSpec,
	palette: GlossyPalette,
): string | null {
	switch (spec.kind) {
		case "timeline":
		case "flow":
		case "org_chart":
			return toMermaidFence(
				fillVisualColors(visualSpecToMermaid(spec), palette),
			);
		case "comparison":
			return comparisonToMarkdownTable(spec);
		default:
			return null;
	}
}

/** The activity attempt was cancelled, so no further model call should start. */
function isCancellation(
	error: unknown,
	abortSignal: AbortSignal | undefined,
): boolean {
	return abortSignal?.aborted === true || error instanceof CancelledFailure;
}

function pastDeadline(deadline: Date | undefined): boolean {
	return (
		deadline !== undefined &&
		deadline.getTime() - Date.now() < EXTRACTION_RESERVE_MS
	);
}

/**
 * Bump the document's progress, and with it `updatedAt`, while the run still
 * owns it: the page reads a GENERATING document whose `updatedAt` stops
 * moving as stalled. Guarded on the run token and on GENERATING, so a
 * superseded run never moves a newer run's clock or status. Best-effort.
 */
async function reportVisualProgress(
	input: GenerateProposalVisualsInput,
	progress: number,
): Promise<void> {
	try {
		await db.projectDocument.updateMany({
			where: {
				id: input.documentId,
				liveRunId: input.liveRunId,
				status: "GENERATING",
			},
			data: { generationProgress: progress, updatedAt: new Date() },
		});
	} catch (error) {
		activityLogger.warn("Proposal visuals progress write failed", {
			documentId: input.documentId,
			liveRunId: input.liveRunId,
			errorName: error instanceof Error ? error.name : typeof error,
		});
	}
}

/**
 * Run `fn` over `items` with at most `limit` in flight; indexes are kept.
 * The first failure stops new work, waits for the calls already in flight,
 * then throws, so nothing keeps running after the activity has returned.
 */
async function forEachWithConcurrency<T>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
	let next = 0;
	let failure: { error: unknown } | null = null;
	const worker = async () => {
		while (failure === null && next < items.length) {
			const index = next++;
			try {
				await fn(items[index], index);
			} catch (error) {
				failure ??= { error };
			}
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, worker),
	);
	if (failure !== null) {
		throw (failure as { error: unknown }).error;
	}
}
