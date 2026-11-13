/**
 * The decision loop behind one release-notes screenshot, separate from the
 * browser and the model so it can be tested with stand-ins for both.
 *
 * Each step: read the page, ask the model for one operation from the QA
 * runner's closed set (click, fill, press, goto, wait) or `capture`, perform
 * it, repeat. A click on a control named like it changes data, and Enter, are
 * refused rather than performed, as is a `goto` to an administration or
 * settings path. A capture is refused on a sign-in form or an administration
 * screen, and otherwise masks personal data on the page first, then takes the
 * named element or the visible page. The step cap bounds the wall clock and
 * the bill; reaching it without a capture is a failure with a reason, which
 * becomes an empty slot in the review.
 */
import {
	NEWSLETTER_CAPTURE_BRIEF_MAX,
	NEWSLETTER_IMAGE_ALT_TEXT_MAX,
} from "@repo/database/src/newsletter-schema";
import type { z } from "zod";
import type {
	BrowserOperation,
	OperationOutcome,
} from "../qa-agentic-run/browser-driver";
import {
	describeModelFailure,
	type ModelDecision,
} from "../qa-agentic-run/model-decision";
import {
	type ActDecisionSchema,
	normaliseOperation,
} from "../qa-agentic-run/operation-decision";
import { maskText } from "./screenshot-masking";

type ActDecision = z.infer<typeof ActDecisionSchema>;

/** Operations a capture may take before it gives up. */
const CAPTURE_MAX_OPERATIONS = 15;

/** A control whose name says it changes data. A capture only looks. */
const DATA_CHANGING_CONTROL =
	/\b(delete|remove|invite|save|submit|confirm|pay|purchase|send|publish|archive|revoke|disconnect|deactivate|sign out|log out|reset)\b/i;

/** A password field in the ARIA snapshot: the page is asking to sign in. */
const PASSWORD_FIELD = /textbox\s+"[^"]*password/i;

/**
 * A path segment that names an administration or settings screen. The prompt
 * says so too, but an org or user copy of the prompt may not, so the loop
 * enforces it.
 */
const ADMINISTRATION_PATH =
	/(^|\/)(admin|administration|settings|billing|members|organization-settings)(\/|$)/i;

/** A query value that opens such a screen in place, like `?tab=settings`. */
const ADMINISTRATION_VIEW =
	/^(admin|administration|settings|billing|members|organization-settings)$/i;

/**
 * Whether a path or URL leads to an administration or settings screen, by its
 * path or by a query value an app uses to switch views in place.
 */
function isAdministrationPath(pathOrUrl: string): boolean {
	let url: URL;
	try {
		url = new URL(pathOrUrl, "https://capture.invalid");
	} catch {
		return false;
	}
	let pathname = url.pathname;
	try {
		pathname = decodeURIComponent(pathname);
	} catch {
		// A malformed escape is read as written.
	}
	return (
		ADMINISTRATION_PATH.test(pathname) ||
		[...url.searchParams.values()].some((value) =>
			ADMINISTRATION_VIEW.test(value.trim()),
		)
	);
}

/** Why the loop will not perform `operation`, or null when it may. */
function refusalOf(operation: BrowserOperation): string | null {
	if (operation.kind === "goto" && isAdministrationPath(operation.path)) {
		return `Refused: “${operation.path}” is an administration or settings screen, which captures never show.`;
	}
	if (
		operation.kind === "click" &&
		DATA_CHANGING_CONTROL.test(operation.name)
	) {
		return `Refused: “${operation.name}” could change data. Capturing only looks at the product.`;
	}
	if (
		operation.kind === "press" &&
		operation.key.trim().toLowerCase() === "enter"
	) {
		return "Refused: Enter could submit a form. Capturing only looks at the product.";
	}
	return null;
}

/** How many earlier steps the prompt repeats. */
const STEP_HISTORY_LIMIT = 10;

/**
 * The QA runner's JSON contract plus `capture`, for a deployment that ignored
 * the schema and answered in prose (see `model-decision.ts`).
 */
export const CAPTURE_JSON_CONTRACT = [
	"Reply with a single JSON object and nothing else — no prose, no markdown fence.",
	'Keys, all optional: "kind" (one of click, fill, press, goto, wait, capture, give_up),',
	'"role", "name", "text", "key", "path", "ms" (a number), "reasoning".',
].join(" ");

/** The browser as the loop sees it. */
export interface CaptureDriver {
	snapshot(): Promise<string>;
	/** The URL of the page as it is now. */
	currentUrl(): string;
	perform(operation: BrowserOperation): Promise<OperationOutcome>;
	/** Replace personal data on the page with placeholders. */
	mask(): Promise<void>;
	/** A PNG of one element, or of the visible page when `target` is null. */
	screenshot(
		target: { role: string; name: string } | null,
	): Promise<Buffer | null>;
}

export type CaptureDecide = (
	prompt: string,
) => Promise<ModelDecision<ActDecision>>;

interface CaptureLoopInput {
	/** The org-editable prompt. */
	instructions: string;
	highlight: { title: string; description: string };
	/** What to show: curation's brief or the reviewer's words. */
	brief: string;
	/** Words masked in the description and reasons: the sign-in name. */
	maskTerms?: readonly string[];
	maxOperations?: number;
}

type CaptureLoopResult =
	| { ok: true; png: Buffer; altText: string; modelCalls: number }
	| { ok: false; reason: string; modelCalls: number };

export function buildCapturePrompt(input: {
	instructions: string;
	highlight: { title: string; description: string };
	brief: string;
	steps: readonly string[];
	snapshot: string;
	remaining: number;
}): string {
	const steps = input.steps.slice(-STEP_HISTORY_LIMIT);
	return [
		input.instructions,
		"",
		`HIGHLIGHT: ${input.highlight.title}`,
		input.highlight.description,
		"",
		`WHAT TO SHOW: ${input.brief.slice(0, NEWSLETTER_CAPTURE_BRIEF_MAX)}`,
		"",
		"STEPS SO FAR:",
		steps.length > 0 ? steps.map((s) => `- ${s}`).join("\n") : "- none",
		`Operations left before the capture is abandoned: ${input.remaining}.`,
		"",
		"PAGE (ARIA snapshot):",
		input.snapshot,
	].join("\n");
}

function captureTarget(
	raw: ActDecision,
): { role: string; name: string } | null {
	const role = raw.role?.trim();
	const name = raw.name?.trim();
	return role && name ? { role, name } : null;
}

/** Drive the page to the screen the brief names and capture it. Never throws. */
export async function runCaptureLoop(
	input: CaptureLoopInput,
	driver: CaptureDriver,
	decide: CaptureDecide,
): Promise<CaptureLoopResult> {
	const maxOperations = input.maxOperations ?? CAPTURE_MAX_OPERATIONS;
	const maskTerms = input.maskTerms ?? [];
	const steps: string[] = [];
	let modelCalls = 0;

	for (let operations = 0; operations <= maxOperations; operations++) {
		let decision: ModelDecision<ActDecision>;
		let snapshot: string;
		try {
			snapshot = await driver.snapshot();
			decision = await decide(
				buildCapturePrompt({
					instructions: input.instructions,
					highlight: input.highlight,
					brief: input.brief,
					steps,
					snapshot,
					remaining: maxOperations - operations,
				}),
			);
		} catch (error) {
			return {
				ok: false,
				reason: `The model could not choose the next step: ${describeModelFailure(error)}`,
				modelCalls,
			};
		}
		modelCalls += decision.calls;
		const raw = decision.value;
		const kind = (raw.kind ?? "").trim().toLowerCase();

		if (kind === "give_up") {
			const found = raw.reasoning?.trim();
			return {
				ok: false,
				reason: found
					? `The screen could not be reached: ${maskText(found, maskTerms)}`
					: "The screen could not be reached.",
				modelCalls,
			};
		}

		if (kind === "capture") {
			if (PASSWORD_FIELD.test(snapshot)) {
				return {
					ok: false,
					reason: "The page shows a sign-in form instead of the screen to capture.",
					modelCalls,
				};
			}
			if (isAdministrationPath(driver.currentUrl())) {
				return {
					ok: false,
					reason: "The screen is an administration or settings screen, which captures never show.",
					modelCalls,
				};
			}
			try {
				await driver.mask();
				const target = captureTarget(raw);
				const png =
					(target ? await driver.screenshot(target) : null) ??
					(await driver.screenshot(null));
				if (!png) {
					return {
						ok: false,
						reason: "The page could not be captured.",
						modelCalls,
					};
				}
				const altText = maskText(
					raw.text?.trim() || input.highlight.title,
					maskTerms,
				).slice(0, NEWSLETTER_IMAGE_ALT_TEXT_MAX);
				return { ok: true, png, altText, modelCalls };
			} catch (error) {
				return {
					ok: false,
					reason: `The page could not be captured: ${error instanceof Error ? (error.message.split("\n")[0] ?? error.message) : String(error)}`,
					modelCalls,
				};
			}
		}

		if (operations === maxOperations) {
			break;
		}
		const operation = normaliseOperation(raw);
		switch (operation.kind) {
			case "none":
				steps.push("Looked at the page without acting.");
				break;
			case "blocked":
				steps.push(`Refused: ${operation.reason}`);
				break;
			case "click":
			case "fill":
			case "press":
			case "goto":
			case "wait": {
				const refusal = refusalOf(operation);
				if (refusal) {
					steps.push(refusal);
					break;
				}
				const outcome = await driver.perform(operation);
				steps.push(
					outcome.ok ? outcome.detail : `Failed: ${outcome.detail}`,
				);
				break;
			}
			default: {
				const exhaustive: never = operation;
				return {
					ok: false,
					reason: `Unsupported operation: ${String(exhaustive)}`,
					modelCalls,
				};
			}
		}
	}

	return {
		ok: false,
		reason: `Stopped after ${maxOperations} steps without reaching the screen to capture.`,
		modelCalls,
	};
}
