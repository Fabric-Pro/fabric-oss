import {
	buildGlossyRewriteInstructions,
	buildGlossyRewritePrompt,
} from "@repo/agent-prompts/glossy";
import { generateText } from "@repo/ai";
// Imported from the SUBPATH (not @repo/ai root) so it stays unmocked in tests
// that mock the root module, as in update-with-context-core.ts.
import { computeScaledOutputTokenBudget } from "@repo/ai/lib/output-token-budget";
import type { GlossySection } from "@repo/utils/glossy/cleanup";
import {
	checkRewrite,
	type FactGuardViolation,
	type GlossyLengthMode,
	isKeySection,
} from "@repo/utils/glossy/fact-guard";
import { headingAnchor, parseOutline } from "@repo/utils/glossy/outline";
import {
	type GlossyAiProviderNotConfigured,
	type GlossyModelContext,
	resolveGlossyModel,
} from "./model";

/**
 * Executive rewrite of one Glossy section (Fizzy #2589, R14–R16, R41, R42,
 * AE2, AE12).
 *
 * `generateText` on the section body only: the heading is context, and a
 * rewrite never carries one back (R15). The output is checked by the
 * deterministic fact guard (`checkRewrite`), plus two structural rules of
 * its own:
 * - no heading at or above the section's own level, which would split the
 *   section;
 * - no image at all. The document's own images are anchors that cleanup
 *   lifts out and the edition re-places, and any other image URL is never
 *   rendered (KTD16), so a rewrite has no reason to carry one. The guard
 *   compares images as a multiset, which a source that quotes an image in
 *   an injected "append this" instruction would otherwise satisfy.
 * A failure gets exactly one retry with the findings fed back; a second
 * failure, or a response cut off at the token limit, keeps the cleaned
 * original with its reason (R16).
 *
 * Before checking, two harmless wrappers are removed: a code fence around
 * the whole answer, and a first line that only echoes the section's own
 * heading. Anything else the model adds is judged as written.
 */

const REWRITE_LOG = "[GlossyRewrite]";

/** A rewrite gets its first attempt plus this one retry (KTD12). */
const MAX_ATTEMPTS = 2;

export interface RewriteGlossySectionInput extends GlossyModelContext {
	documentType: string;
	/** The cleaned section: heading and path for context and key-section class, body to rewrite. */
	section: Pick<
		GlossySection,
		"heading" | "level" | "headingPath" | "markdown"
	>;
	lengthMode: GlossyLengthMode;
}

export type GlossyRewriteKeptOriginalReason =
	/** Both attempts failed the fact or structural guard. */
	| "guardFailed"
	/** A response hit the output-token limit. */
	| "truncated";

export type GlossyRewriteResult =
	| {
			status: "rewritten";
			markdown: string;
			attempts: number;
	  }
	| {
			/** Counts toward "sections kept in original wording" (R16). */
			status: "keptOriginal";
			/** The cleaned original body, unchanged. */
			markdown: string;
			reason: GlossyRewriteKeptOriginalReason;
			/** The last attempt's findings; empty for `truncated`. */
			violations: FactGuardViolation[];
			attempts: number;
	  }
	| {
			/** A heading-only section: nothing to rewrite, no model call. */
			status: "skipped";
			markdown: string;
			reason: "emptySource";
	  }
	| GlossyAiProviderNotConfigured;

export async function rewriteGlossySection(
	input: RewriteGlossySectionInput,
): Promise<GlossyRewriteResult> {
	const { section, lengthMode } = input;
	const source = section.markdown;
	if (!source.trim()) {
		return { status: "skipped", markdown: source, reason: "emptySource" };
	}

	const resolved = await resolveGlossyModel(input);
	if (resolved.status !== "resolved") {
		return resolved;
	}
	const { model, metadata, trackUsage } = resolved;

	const keySection = isKeySection(section.headingPath);
	const instructions = buildGlossyRewriteInstructions(input.documentType);
	let violations: FactGuardViolation[] = [];

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const prompt = buildGlossyRewritePrompt({
			heading: section.heading,
			markdown: source,
			lengthMode,
			isKeySection: keySection,
			retryFindings: attempt > 1 ? violations : undefined,
		});
		// Output tracks the section's length, so scaled mode on the body.
		const maxOutputTokens = computeScaledOutputTokenBudget(metadata, {
			inputChars: source.length,
			promptChars: instructions.length + prompt.length,
		});
		const result = await generateText({
			model,
			instructions,
			prompt,
			...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
			...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
		});
		if (attempt === 1) {
			trackUsage();
		}

		if (result.finishReason === "length") {
			console.warn(`${REWRITE_LOG} Kept original wording`, {
				reason: "truncated",
				attempt,
				projectId: input.projectId,
				provider: metadata.provider,
			});
			return keptOriginal(source, "truncated", [], attempt);
		}

		const output = normalizeRewriteOutput(
			result.text,
			section.heading,
			source,
		);
		violations = [
			...headingLevelViolations(source, output, section.level),
			...imageViolations(output),
			...guardViolations(
				checkRewrite({
					source,
					output,
					isKeySection: keySection,
					lengthMode,
				}),
			),
		];
		if (violations.length === 0) {
			return { status: "rewritten", markdown: output, attempts: attempt };
		}
	}

	console.info(`${REWRITE_LOG} Kept original wording`, {
		reason: "guardFailed",
		projectId: input.projectId,
		violations: violations.map((violation) => violation.kind),
	});
	return keptOriginal(source, "guardFailed", violations, MAX_ATTEMPTS);
}

function keptOriginal(
	markdown: string,
	reason: GlossyRewriteKeptOriginalReason,
	violations: FactGuardViolation[],
	attempts: number,
): GlossyRewriteResult {
	return { status: "keptOriginal", markdown, reason, violations, attempts };
}

function guardViolations(
	result: ReturnType<typeof checkRewrite>,
): FactGuardViolation[] {
	return result.pass ? [] : result.violations;
}

// ---------------------------------------------------------------------------
// Output normalization
// ---------------------------------------------------------------------------

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*(markdown|md)?[ \t]*$/i;
const ATX_HEADING = /^ {0,3}#{1,6}(?:[ \t]+|$)/;

/**
 * Remove what is wrapping, not content: a single fence around the whole
 * answer (plain or `markdown`) and a leading line that repeats the section's
 * own heading. Line endings are normalized and the result trimmed. A source
 * that itself opens with a fence keeps an output fence as written.
 */
export function normalizeRewriteOutput(
	text: string,
	heading: string | null,
	source: string,
): string {
	let lines = text.replace(/\r\n?/g, "\n").trim().split("\n");

	const open = lines[0]?.match(FENCE_OPEN);
	const last = lines[lines.length - 1]?.trim() ?? "";
	if (
		open &&
		!FENCE_LINE.test(source.trimStart()) &&
		lines.length >= 2 &&
		last.length >= open[1].length &&
		last === open[1][0].repeat(last.length)
	) {
		lines = lines.slice(1, -1);
	}

	const firstIndex = lines.findIndex((line) => line.trim() !== "");
	if (
		heading &&
		firstIndex >= 0 &&
		ATX_HEADING.test(lines[firstIndex]) &&
		headingAnchor(lines[firstIndex].replace(/^ {0,3}#{1,6}/, "")) ===
			headingAnchor(heading)
	) {
		lines = lines.slice(firstIndex + 1);
	}

	return lines.join("\n").trim();
}

// ---------------------------------------------------------------------------
// Heading level
// ---------------------------------------------------------------------------

const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;
/** A line that cannot be a setext heading's text: blank, a block marker, or indented code. */
const NOT_PARAGRAPH =
	/^(?:\s*$| {4,}|\t| {0,3}(?:[-*+][ \t]|\d+[.)][ \t]|#|>|\||`{3,}|~{3,}|<))/;
const MAX_VIOLATION_TEXT = 120;

/** Setext headings (`Text` over `===` or `---`) outside fences, with their level. */
function setextHeadings(
	markdown: string,
): Array<{ level: number; text: string }> {
	const lines = markdown.split("\n");
	const found: Array<{ level: number; text: string }> = [];
	let fence: string | null = null;
	for (let i = 0; i < lines.length; i++) {
		const marker = lines[i].match(FENCE_LINE);
		if (marker) {
			if (fence === null) {
				fence = marker[1][0];
			} else if (marker[1][0] === fence) {
				fence = null;
			}
			continue;
		}
		if (fence !== null || i === 0) {
			continue;
		}
		const underline = lines[i].match(SETEXT_UNDERLINE);
		if (underline && !NOT_PARAGRAPH.test(lines[i - 1])) {
			found.push({
				level: underline[1][0] === "=" ? 1 : 2,
				text: lines[i - 1].trim(),
			});
		}
	}
	return found;
}

function clip(text: string): string {
	const single = text.replace(/\s+/g, " ").trim();
	return single.length > MAX_VIOLATION_TEXT
		? `${single.slice(0, MAX_VIOLATION_TEXT - 1)}…`
		: single;
}

/**
 * A heading at or above the section's own level would start a new section
 * in the assembled edition (R15). The fact guard already rejects a heading
 * the source lacks; this also catches a source heading promoted to the
 * section's level, and a setext heading, which the guard's ATX-only outline
 * does not see. A section with no heading of its own (level 0, text before
 * the first heading) may gain no heading at all.
 */
function headingLevelViolations(
	source: string,
	output: string,
	level: number,
): FactGuardViolation[] {
	const ceiling = level > 0 ? level : 6;
	const atx = parseOutline(output)
		.filter((heading) => heading.level <= ceiling)
		.map((heading) => ({
			level: heading.level,
			text: `${"#".repeat(heading.level)} ${heading.text}`,
		}));
	// A source that already uses setext underlines keeps them; flagging them
	// would reject a faithful copy.
	const setext =
		setextHeadings(source).length > 0
			? []
			: setextHeadings(output).filter(
					(heading) => heading.level <= ceiling,
				);
	return [...atx, ...setext].map((heading) => ({
		kind: "structural",
		text: clip(heading.text),
		message: `Adds a heading at or above the section's own level, which would split the section: ${clip(heading.text)}`,
	}));
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

/** The start of a markdown image, inline or reference style, or an `<img>` tag. */
const IMAGE_START = /!\[[^\]\n]{0,500}\]\s?[([]|<img\b/gi;

function imageViolations(output: string): FactGuardViolation[] {
	return Array.from(output.matchAll(IMAGE_START), (match) => {
		const start = match.index ?? 0;
		const text = clip(output.slice(start, start + 200).split("\n")[0]);
		return {
			kind: "structural" as const,
			text,
			message: `Includes an image, which a rewrite never carries: ${text}`,
		};
	});
}
