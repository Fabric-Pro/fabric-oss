/**
 * Diagrams and visual-slot tags held out of an AI edit of a Proposal's Main
 * as numbered placeholders, and put back after it (Fizzy #2946).
 *
 * Both AI writers of an artifact Proposal use this one rule: the chat's
 * heading-anchored patches (`[[fabric-visual-n]]` tokens over the whole
 * document) and the finding-driven revision of one section
 * (`<<<FABRIC_VISUAL_n>>>` tokens over its body). Only the token shape is
 * the caller's.
 *
 * ## What is held
 *
 * - A diagram fence, by the editor's own test (`isDiagramFence`), from its
 *   opening line to its closing line, or to the last line when it is never
 *   closed (Markdown, and so the server's preservation check, reads an
 *   unclosed fence to the end). It becomes one placeholder line. Any other
 *   fence is content and stays as it is.
 * - A visual-slot tag outside a fence. A line holding only slot tags becomes
 *   one placeholder line; a tag on a line with other text becomes a
 *   placeholder in place.
 *
 * ## What must come back
 *
 * Every placeholder exactly once, a line placeholder alone on its line,
 * except one the caller lists as removable (inside a deleted section), which
 * may also be gone. Placeholder-shaped text that stands for nothing is
 * refused too. Restoration is byte for byte.
 *
 * Pure and browser-safe. The source is used as given: a caller that works in
 * `\n` normalizes line endings first.
 */

import { FENCE_MARKER, scanFences, VISUAL_SLOT_TAG } from "../glossy/outline";
import { isDiagramFence } from "./section-hash";

/**
 * The shape of a caller's tokens: `prefix` + the 1-based number + `suffix`.
 * `prefix(0)` is tried first, then `prefix(1)` and so on, until one the
 * source does not contain, so a token can never be confused with text the
 * source already holds.
 */
export interface VisualPlaceholderFormat {
	prefix: (attempt: number) => string;
	suffix: string;
}

export interface VisualPlaceholder {
	/** The placeholder text the model sees. */
	token: string;
	/** The original text it stands for, restored byte for byte. */
	raw: string;
	/** Whether the placeholder stands alone on its line (fences, slot lines). */
	ownLine: boolean;
	/** 1-based line of the model text the placeholder sits on. */
	modelLine: number;
}

export interface VisualPlaceholderView {
	/** The text as given. */
	sourceDocument: string;
	/** What the model sees: every diagram and slot tag a placeholder. */
	modelDocument: string;
	placeholders: VisualPlaceholder[];
	/** The token prefix chosen for this source. */
	tokenPrefix: string;
	/** The token suffix, the format's. */
	tokenSuffix: string;
	/** For each 1-based model line (index `line - 1`), its first source line. */
	sourceStartLine: number[];
	/** For each 1-based model line (index `line - 1`), its last source line. */
	sourceEndLine: number[];
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One HTML attribute, in any quoting (the slot module's grammar). */
const SLOT_ATTRIBUTE = `\\s+[^\\s"'<>/=]+(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s"'=<>\`]+))?`;

/** A slot tag with its optional closing tag, or a stray closing tag. */
const SLOT_TAG_SOURCE = `<${VISUAL_SLOT_TAG}(?:${SLOT_ATTRIBUTE})*\\s*/?>(?:\\s*</${VISUAL_SLOT_TAG}\\s*>)?|</${VISUAL_SLOT_TAG}\\s*>`;

/** The fence's language: the first word of its info string, or null. */
function fenceLanguage(openLine: string): string | null {
	return openLine.replace(FENCE_MARKER, "").trim().split(/\s+/)[0] || null;
}

/** The text the model sees, with every diagram and slot tag held. */
export function holdVisualPlaceholders(
	source: string,
	format: VisualPlaceholderFormat,
): VisualPlaceholderView {
	let attempt = 0;
	while (source.includes(format.prefix(attempt))) {
		attempt++;
	}
	const tokenPrefix = format.prefix(attempt);
	const tokenSuffix = format.suffix;
	const lines = source.split("\n");
	const roles = scanFences(lines);
	const slotTag = new RegExp(SLOT_TAG_SOURCE, "gi");
	const hasSlotTag = new RegExp(SLOT_TAG_SOURCE, "i");

	const placeholders: VisualPlaceholder[] = [];
	const modelLines: string[] = [];
	const sourceStartLine: number[] = [];
	const sourceEndLine: number[] = [];
	const nextToken = () =>
		`${tokenPrefix}${placeholders.length + 1}${tokenSuffix}`;
	const holdLine = (raw: string, first: number, last: number) => {
		const token = nextToken();
		placeholders.push({
			token,
			raw,
			ownLine: true,
			modelLine: modelLines.length + 1,
		});
		modelLines.push(token);
		sourceStartLine.push(first + 1);
		sourceEndLine.push(last + 1);
	};
	const keepLine = (line: string, index: number) => {
		modelLines.push(line);
		sourceStartLine.push(index + 1);
		sourceEndLine.push(index + 1);
	};

	let index = 0;
	while (index < lines.length) {
		const line = lines[index];
		if (roles[index] === "open") {
			let end = index + 1;
			while (end < lines.length && roles[end] === "inside") {
				end++;
			}
			const last =
				end < lines.length && roles[end] === "close" ? end : end - 1;
			const body = lines.slice(index + 1, end).join("\n");
			const block = lines.slice(index, last + 1);
			if (isDiagramFence(fenceLanguage(line), body)) {
				holdLine(block.join("\n"), index, last);
			} else {
				for (let offset = 0; offset < block.length; offset++) {
					keepLine(block[offset], index + offset);
				}
			}
			index = last + 1;
			continue;
		}
		if (!hasSlotTag.test(line)) {
			keepLine(line, index);
		} else if (!line.replace(slotTag, "").trim()) {
			holdLine(line, index, index);
		} else {
			const modelLine = modelLines.length + 1;
			keepLine(
				line.replace(slotTag, (tag) => {
					const token = nextToken();
					placeholders.push({
						token,
						raw: tag,
						ownLine: false,
						modelLine,
					});
					return token;
				}),
				index,
			);
		}
		index++;
	}

	return {
		sourceDocument: source,
		modelDocument: modelLines.join("\n"),
		placeholders,
		tokenPrefix,
		tokenSuffix,
		sourceStartLine,
		sourceEndLine,
	};
}

export type VisualPlaceholderRestore =
	| { ok: true; document: string }
	| {
			ok: false;
			/** Placeholders that went missing and were not removable. */
			missing: string[];
			/** Placeholders that appear more than once. */
			repeated: string[];
			/** Placeholder-shaped text that stands for nothing. */
			unknown: string[];
			/** Line placeholders that no longer stand alone on their line. */
			misplaced: string[];
	  };

const NONE_REMOVABLE: ReadonlySet<string> = new Set();

/**
 * The edited model text with every placeholder replaced by the text it
 * stands for, or why it cannot be (naming placeholders only).
 */
export function restoreVisualPlaceholders(
	view: VisualPlaceholderView,
	edited: string,
	removable: ReadonlySet<string> = NONE_REMOVABLE,
): VisualPlaceholderRestore {
	const byToken = new Map(
		view.placeholders.map((placeholder) => [
			placeholder.token,
			placeholder,
		]),
	);
	const tokenPattern = new RegExp(
		`${escapeRegExp(view.tokenPrefix)}\\d+${escapeRegExp(view.tokenSuffix)}`,
		"g",
	);
	const counts = new Map<string, number>();
	const unknown = new Set<string>();
	for (const match of edited.matchAll(tokenPattern)) {
		const token = match[0];
		if (!byToken.has(token)) {
			unknown.add(token);
			continue;
		}
		counts.set(token, (counts.get(token) ?? 0) + 1);
	}

	const lines = edited.split("\n");
	const standaloneCounts = new Map<string, number>();
	for (const line of lines) {
		const trimmed = line.trim();
		if (byToken.get(trimmed)?.ownLine) {
			standaloneCounts.set(
				trimmed,
				(standaloneCounts.get(trimmed) ?? 0) + 1,
			);
		}
	}

	const missing: string[] = [];
	const repeated: string[] = [];
	const misplaced: string[] = [];
	for (const placeholder of view.placeholders) {
		const count = counts.get(placeholder.token) ?? 0;
		if (count === 0 && !removable.has(placeholder.token)) {
			missing.push(placeholder.token);
		}
		if (count > 1) {
			repeated.push(placeholder.token);
		}
		if (
			placeholder.ownLine &&
			count > 0 &&
			(standaloneCounts.get(placeholder.token) ?? 0) !== count
		) {
			misplaced.push(placeholder.token);
		}
	}
	if (
		missing.length > 0 ||
		repeated.length > 0 ||
		unknown.size > 0 ||
		misplaced.length > 0
	) {
		return {
			ok: false,
			missing,
			repeated,
			unknown: [...unknown],
			misplaced,
		};
	}

	const restoredLines = lines.map((line) => {
		const placeholder = byToken.get(line.trim());
		return placeholder?.ownLine ? placeholder.raw : line;
	});
	const document = restoredLines
		.join("\n")
		.replace(tokenPattern, (token) => byToken.get(token)?.raw ?? token);
	return { ok: true, document };
}
