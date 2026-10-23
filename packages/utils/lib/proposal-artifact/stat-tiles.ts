/**
 * Stat tiles in a Proposal's Main body (Fizzy #2946): a big number with a
 * short label, one to four across.
 *
 * The markdown form is a fenced block with the hyphenated language
 * `stat-tiles` and one `label: value` line per tile:
 *
 *   ```stat-tiles
 *   %% fabric-visual: a1b2c3d4e5f6
 *   Faster onboarding: 40%
 *   Pilot sites: 3
 *   ```
 *
 * A generated block may open with one `%% fabric-visual: <id>` line naming
 * the visual it came from; that line is never a tile. Nothing else is
 * evaluated: no raw HTML, no YAML, no JSON. Each line splits at its first
 * colon followed by a space, so a value may itself hold a colon (`3:1`).
 *
 * The fence keeps its body as plain text, so a block this parser refuses is
 * still kept byte for byte: readers render it as an ordinary code block
 * instead of tiles, and the editor shows {@link STAT_TILES_RULE} beside the
 * source.
 *
 * Pure functions and data only: client components import this module, so it
 * must not pull in anything the browser bundle cannot carry.
 */

/** The fence language that marks a stat tiles block. */
export const STAT_TILES_LANGUAGE = "stat-tiles";

/** What a block may hold. Lengths count characters, not UTF-16 units. */
export const STAT_TILES_LIMITS = {
	minItems: 1,
	maxItems: 4,
	maxLabelLength: 80,
	maxValueLength: 24,
	/**
	 * The longest body read at all. Four full tiles and a marker fit in well
	 * under a tenth of this; anything longer is refused before it is split.
	 */
	maxBodyLength: 2048,
} as const;

/**
 * The one-line rule a refused block is shown with. Every `reason` starts
 * with it, so whoever reads the reason learns the shape that would render.
 */
export const STAT_TILES_RULE =
	"Stat tiles need 1–4 lines written as label: value.";

/** One tile: the short label and the big value, both trimmed. */
export interface StatTileItem {
	label: string;
	value: string;
}

export type StatTilesParseResult =
	| {
			ok: true;
			/** The `%% fabric-visual:` id, or `null` for a hand-written block. */
			visualId: string | null;
			items: StatTileItem[];
	  }
	| { ok: false; reason: string };

/** Any line opening with this is a marker, valid only as the first line. */
const MARKER_PREFIX = "%%";
/**
 * A generated visual's marker line, trimmed, capturing its id. Shared with
 * the mermaid fences' identity (`visual-identity.ts`), so one rule says what
 * a marker is.
 */
export const VISUAL_MARKER_PATTERN = /^%% fabric-visual: ([a-z0-9]{12,32})$/;
const ITEM_SEPARATOR = ": ";

function refuse(detail: string): StatTilesParseResult {
	return { ok: false, reason: `${STAT_TILES_RULE} ${detail}` };
}

function characterCount(text: string): number {
	return Array.from(text).length;
}

/**
 * Read a stat tiles fence body (the text between the fences).
 *
 * Strict by design, because a refused block still renders, as code: every
 * non-blank line must be `label: value` with both sides non-empty after
 * trimming, the label at most 80 characters and the value at most 24, and
 * there must be one to four of them. Only the first non-blank line may be the
 * `%% fabric-visual: <id>` marker, its id 12 to 32 lowercase letters or
 * digits; a malformed marker, or a `%%` line anywhere else, refuses the
 * block. Blank lines are ignored and CRLF line ends are read as LF.
 */
export function parseStatTiles(body: string): StatTilesParseResult {
	if (body.length > STAT_TILES_LIMITS.maxBodyLength) {
		return refuse(
			`This block is longer than ${STAT_TILES_LIMITS.maxBodyLength} characters.`,
		);
	}

	const lines = body.split(/\r\n|\r|\n/);
	const items: StatTileItem[] = [];
	let visualId: string | null = null;
	let seenContent = false;

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

		const separator = line.indexOf(ITEM_SEPARATOR);
		if (separator === -1) {
			return refuse(
				`Line ${lineNumber} has no "label: value" separator.`,
			);
		}
		const label = line.slice(0, separator).trim();
		const value = line.slice(separator + ITEM_SEPARATOR.length).trim();
		if (label === "" || value === "") {
			return refuse(`Line ${lineNumber} needs both a label and a value.`);
		}
		if (characterCount(label) > STAT_TILES_LIMITS.maxLabelLength) {
			return refuse(
				`The label on line ${lineNumber} is longer than ${STAT_TILES_LIMITS.maxLabelLength} characters.`,
			);
		}
		if (characterCount(value) > STAT_TILES_LIMITS.maxValueLength) {
			return refuse(
				`The value on line ${lineNumber} is longer than ${STAT_TILES_LIMITS.maxValueLength} characters.`,
			);
		}

		items.push({ label, value });
		if (items.length > STAT_TILES_LIMITS.maxItems) {
			return refuse(
				`This block has more than ${STAT_TILES_LIMITS.maxItems}.`,
			);
		}
	}

	if (items.length < STAT_TILES_LIMITS.minItems) {
		return refuse("This block has none.");
	}

	return { ok: true, visualId, items };
}
