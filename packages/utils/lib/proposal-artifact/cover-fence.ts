/**
 * The cover details of a Proposal (Fizzy #2946): the eyebrow above the
 * title, the line under the logos, who the Proposal is prepared for and by,
 * and its version.
 *
 * The markdown form is a fenced block with the language `cover` in the
 * preamble, before the first `##` heading, with one `key: value` line per
 * field:
 *
 *   ```cover
 *   eyebrow: Proposal · Operations board
 *   organization: Example Harbor Co · Logistics division
 *   for: Example Harbor Co
 *   for: 1 Example Quay, Example City
 *   by: Example Delivery Team
 *   by: example.com
 *   version: 12
 *   ```
 *
 * Every key is optional, so a cover the fence leaves out keeps its default
 * text. `eyebrow`, `organization` and `version` appear at most once; `for`
 * and `by` hold one to three lines each when present, in the order written.
 * The cover of the print and of the Word document reads the fence; the body
 * never prints it.
 *
 * A generated block may open with one `%% fabric-visual: <id>` line naming
 * the visual it came from, as stat tiles may; that line is never a field.
 * Nothing else is evaluated: no raw HTML, no YAML, no JSON, no inline marks.
 * Each line splits at its first colon, so a value may itself hold one
 * (`by: https://example.com`). Values are plain text, trimmed and kept as
 * written; every surface escapes them itself.
 *
 * The fence keeps its body as plain text, so a block this parser refuses is
 * still kept byte for byte: readers render it as an ordinary code block, and
 * the editor shows the reason beside the source. Every reason starts with
 * {@link COVER_RULE}.
 *
 * Pure functions and data only: client components import this module, so it
 * must not pull in anything the browser bundle cannot carry.
 */

import { VISUAL_MARKER_PATTERN } from "./stat-tiles";

/** The fence language that marks a cover block. */
export const COVER_LANGUAGE = "cover";

/** What a block may hold. Lengths count characters, not UTF-16 units. */
export const COVER_LIMITS = {
	maxEyebrowLength: 80,
	maxOrganizationLength: 120,
	/** The most `for:` lines, and the most `by:` lines. */
	maxPartyLines: 3,
	/** One `for:` or `by:` line: a name, an address or a website. */
	maxPartyLineLength: 120,
	maxVersionLength: 24,
	/**
	 * The longest body read at all. Every field at its longest, and a
	 * marker, fit in well under half of this; anything longer is refused
	 * before it is split.
	 */
	maxBodyLength: 2048,
} as const;

/**
 * The one-line rule a refused block is shown with. Every `reason` starts
 * with it, so whoever reads the reason learns the shape that would render.
 */
export const COVER_RULE =
	"A cover needs key: value lines: eyebrow, organization and version at most once each, for and by up to 3 times each.";

/** The fields a cover block sets; an absent field is `null` or empty. */
export interface CoverDetails {
	/** The eyebrow above the title, in place of the fixed one. */
	eyebrow: string | null;
	/** The line under the logos. */
	organization: string | null;
	/** The prepared-for block, one entry per `for:` line. */
	forLines: string[];
	/** The prepared-by block, one entry per `by:` line. */
	byLines: string[];
	/** The version the date line names. */
	version: string | null;
}

export type CoverParseResult =
	| ({
			ok: true;
			/** The `%% fabric-visual:` id, or `null` for a hand-written block. */
			visualId: string | null;
	  } & CoverDetails)
	| { ok: false; reason: string };

/** The keys a line may set, as written: lower case only. */
const COVER_KEYS = ["eyebrow", "organization", "for", "by", "version"] as const;

type CoverKey = (typeof COVER_KEYS)[number];

/** The longest value of each key. */
const MAX_VALUE_LENGTH: Readonly<Record<CoverKey, number>> = {
	eyebrow: COVER_LIMITS.maxEyebrowLength,
	organization: COVER_LIMITS.maxOrganizationLength,
	for: COVER_LIMITS.maxPartyLineLength,
	by: COVER_LIMITS.maxPartyLineLength,
	version: COVER_LIMITS.maxVersionLength,
};

/** Any line opening with this is a marker, valid only as the first line. */
const MARKER_PREFIX = "%%";
const KEY_SEPARATOR = ":";

function refuse(detail: string): CoverParseResult {
	return { ok: false, reason: `${COVER_RULE} ${detail}` };
}

function characterCount(text: string): number {
	return Array.from(text).length;
}

function isCoverKey(key: string): key is CoverKey {
	return (COVER_KEYS as readonly string[]).includes(key);
}

/**
 * Read a cover fence body (the text between the fences).
 *
 * Strict by design, because a refused block still renders, as code: every
 * non-blank line must be `key: value`, the key one of `eyebrow`,
 * `organization`, `for`, `by` and `version` in lower case, the value
 * non-empty after trimming. The eyebrow is at most 80 characters, the
 * organization line 120, each `for:` and `by:` line 120 and the version 24.
 * A second `eyebrow`, `organization` or `version` line, or a fourth `for` or
 * `by` line, refuses the block, as does a block with no field at all. Only
 * the first non-blank line may be the `%% fabric-visual: <id>` marker; a
 * malformed marker, or a `%%` line anywhere else, refuses the block. Blank
 * lines are ignored and CRLF line ends are read as LF.
 */
export function parseCover(body: string): CoverParseResult {
	if (body.length > COVER_LIMITS.maxBodyLength) {
		return refuse(
			`This block is longer than ${COVER_LIMITS.maxBodyLength} characters.`,
		);
	}

	const lines = body.split(/\r\n|\r|\n/);
	const details: CoverDetails = {
		eyebrow: null,
		organization: null,
		forLines: [],
		byLines: [],
		version: null,
	};
	let visualId: string | null = null;
	let seenContent = false;
	let fieldCount = 0;

	for (const [index, rawLine] of lines.entries()) {
		const line = rawLine.trim();
		if (line === "") {
			continue;
		}
		const lineNumber = index + 1;
		const isFirstContentLine = !seenContent;
		seenContent = true;

		if (line.startsWith(MARKER_PREFIX)) {
			if (!isFirstContentLine) {
				return refuse(
					`Only the first line may be the fabric-visual marker (line ${lineNumber}).`,
				);
			}
			const marker = VISUAL_MARKER_PATTERN.exec(line);
			if (!marker) {
				return refuse(
					`Line ${lineNumber} is not a valid fabric-visual marker.`,
				);
			}
			visualId = marker[1] ?? null;
			continue;
		}

		const separator = line.indexOf(KEY_SEPARATOR);
		if (separator === -1) {
			return refuse(`Line ${lineNumber} has no "key: value" separator.`);
		}
		const key = line.slice(0, separator).trim();
		const value = line.slice(separator + KEY_SEPARATOR.length).trim();
		if (!isCoverKey(key)) {
			return refuse(`Line ${lineNumber} has the unknown key "${key}".`);
		}
		if (value === "") {
			return refuse(`Line ${lineNumber} needs a value after "${key}:".`);
		}
		if (characterCount(value) > MAX_VALUE_LENGTH[key]) {
			return refuse(
				`The ${key} value on line ${lineNumber} is longer than ${MAX_VALUE_LENGTH[key]} characters.`,
			);
		}

		if (key === "for" || key === "by") {
			const party = key === "for" ? details.forLines : details.byLines;
			party.push(value);
			if (party.length > COVER_LIMITS.maxPartyLines) {
				return refuse(
					`This block has more than ${COVER_LIMITS.maxPartyLines} ${key} lines (line ${lineNumber}).`,
				);
			}
		} else {
			if (details[key] !== null) {
				return refuse(
					`This block has more than one ${key} line (line ${lineNumber}).`,
				);
			}
			details[key] = value;
		}
		fieldCount += 1;
	}

	if (fieldCount === 0) {
		return refuse("This block has none.");
	}

	return { ok: true, visualId, ...details };
}
