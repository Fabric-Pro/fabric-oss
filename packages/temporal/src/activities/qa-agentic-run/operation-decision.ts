import { z } from "zod";
import type { BrowserOperation } from "./browser-driver";

/**
 * Lenient on purpose — `kind` and the target are plain strings, not enums.
 *
 * A strict `z.enum` turns "Click" or "CLICK" into a schema-rejection retry loop
 * and, on a model that keeps missing, an outright activity failure. Normalised
 * below, where incomplete or unsupported actions are blocked without assessment.
 */
export const ActDecisionSchema = z.object({
	kind: z.string().optional(),
	role: z.string().optional(),
	name: z.string().optional(),
	text: z.string().optional(),
	key: z.string().optional(),
	path: z.string().optional(),
	ms: z.number().optional(),
	reasoning: z.string().optional(),
});

const OPERATION_KINDS = new Set([
	"click",
	"fill",
	"type",
	"press",
	"goto",
	"navigate",
	"wait",
	"none",
]);
export function operationKindForLog(rawKind: string | undefined): string {
	const kind = rawKind?.trim().toLowerCase() ?? "";
	return OPERATION_KINDS.has(kind) ? kind : "unknown";
}

/** Map whatever the model said onto the closed operation set. */
export function normaliseOperation(
	raw: z.infer<typeof ActDecisionSchema>,
): BrowserOperation | { kind: "none" } | { kind: "blocked"; reason: string } {
	const kind = (raw.kind ?? "").trim().toLowerCase();
	switch (kind) {
		case "click":
			return raw.role?.trim() && raw.name?.trim()
				? { kind: "click", role: raw.role, name: raw.name }
				: {
						kind: "blocked",
						reason: "The requested click operation is missing a role or accessible name.",
					};
		case "fill":
		case "type":
			return raw.role?.trim() && raw.name?.trim()
				? {
						kind: "fill",
						role: raw.role,
						name: raw.name,
						text: raw.text ?? "",
					}
				: {
						kind: "blocked",
						reason: "The requested fill operation is missing a role or accessible name.",
					};
		case "press":
			return raw.key?.trim()
				? { kind: "press", key: raw.key }
				: {
						kind: "blocked",
						reason: "The requested press operation is missing a key.",
					};
		case "goto":
		case "navigate":
			return raw.path?.trim()
				? { kind: "goto", path: raw.path }
				: {
						kind: "blocked",
						reason: "The requested goto operation is missing a path.",
					};
		case "wait":
			return { kind: "wait", ms: raw.ms ?? 1000 };
		case "none":
			return { kind: "none" };
		default:
			return {
				kind: "blocked",
				reason:
					kind.length === 0
						? "The requested operation kind is missing."
						: "The requested operation kind is not supported by the QA runner.",
			};
	}
}

export const AssessDecisionSchema = z.object({
	met: z.boolean().optional(),
	observation: z.string().optional(),
	/**
	 * How sure the model is of `met`, 0–100.
	 *
	 * Optional like everything else here, and its absence is NOT read as zero:
	 * "I did not say how sure I was" and "I was not sure" are different answers,
	 * and a provider that drops the field would otherwise send every step of every
	 * project to review at once. The runner applies its confidence policy.
	 */
	confidence: z.number().optional(),
});

/**
 * Spelled-out JSON contracts, used ONLY when a deployment ignored the schema and
 * answered in prose (see `model-decision.ts`). They describe the same shapes as
 * the schemas above in words, because the fallback's whole premise is a provider
 * that did not read the schema.
 *
 * Kept beside the schemas rather than in the org-editable prompt: an admin
 * editing how strictly their team judges an expectation must not be able to
 * break the wire format the runner parses.
 */
export const ACT_JSON_CONTRACT = [
	"Reply with a single JSON object and nothing else — no prose, no markdown fence.",
	'Keys, all optional: "kind" (one of click, fill, press, goto, wait, none),',
	'"role", "name", "text", "key", "path", "ms" (a number), "reasoning".',
].join(" ");

export const ASSESS_JSON_CONTRACT = [
	"Reply with a single JSON object and nothing else — no prose, no markdown fence.",
	'Keys, all optional: "met" (true or false), "observation" (one or two sentences),',
	'"confidence" (a number from 0 to 100 — how sure you are of "met", where 100 is',
	"certain and anything below 50 means you are guessing).",
].join(" ");
