/**
 * Pure helpers for `fabric_add_instruction_lesson` — building the
 * `Lessons/<date>-<slug>.md` path and frontmatter for a lesson an agent
 * records, before it is submitted as an ordinary proposal through
 * `submitInstructionChange`.
 *
 * Kept separate from `platform-tools.ts` and free of I/O (no Prisma, no
 * `@repo/database`, no dynamic imports) so the slugging, collision and
 * rendering rules can be unit-tested without the gateway's session and
 * access-gate machinery around them.
 */

/** The folder every lesson file lands under. */
const LESSONS_DIR = "Lessons";

/** `renderLesson`'s `description` frontmatter field is capped to this length. */
const MAX_DESCRIPTION_LENGTH = 160;

/** `lessonSlug`'s output is capped to this length, trailing `-` stripped after truncation. */
const MAX_SLUG_LENGTH = 60;

/** Combining marks left behind by `"NFKD".normalize()` — stripped to fold `café` to `cafe`. */
const COMBINING_MARK = /[\u0300-\u036f]/g;

/** Any run of characters that is not a lowercase ASCII letter or digit. */
const NON_ALPHANUMERIC_RUN = /[^a-z0-9]+/g;

/** How many suffixed attempts `lessonPath` tries before giving up. */
const MAX_COLLISION_ATTEMPTS = 50;

/**
 * A filesystem- and URL-safe slug for a lesson title.
 *
 * Lowercases, folds accented characters to their base letter (`café` →
 * `cafe`) via Unicode compatibility decomposition, collapses everything that
 * is not `[a-z0-9]` into a single `-`, and trims leading/trailing `-`. Capped
 * at {@link MAX_SLUG_LENGTH} characters without ending on a trailing `-`, and
 * never empty — a title that slugs to nothing (all punctuation, all
 * whitespace, all non-Latin script `normalize` cannot fold) falls back to
 * `"lesson"` so {@link lessonPath} always has something to suffix.
 */
export function lessonSlug(title: string): string {
	const folded = title
		.normalize("NFKD")
		.replace(COMBINING_MARK, "")
		.toLowerCase();
	const slug = folded
		.replace(NON_ALPHANUMERIC_RUN, "-")
		.replace(/^-+|-+$/g, "");
	if (slug.length === 0) {
		return "lesson";
	}
	if (slug.length <= MAX_SLUG_LENGTH) {
		return slug;
	}
	const truncated = slug.slice(0, MAX_SLUG_LENGTH).replace(/-+$/, "");
	return truncated.length === 0 ? "lesson" : truncated;
}

/**
 * The `Lessons/<YYYY-MM-DD>-<slug>.md` path for a new lesson, suffixed
 * `-2`, `-3`, … when the unsuffixed path collides with one already in
 * `taken`.
 *
 * `date` is read in UTC, matching the convention the rest of the
 * coding-instructions surface uses for anything date-stamped in a path
 * rather than a database column. `taken` is compared case-insensitively
 * (lower-cased) because the instruction tree is: see `canonicalKey` in
 * `packages/instructions/src/kinds.ts`, which this mirrors rather than
 * imports — the comparison here is ASCII-only (dates and slugs), so the
 * lowercasing `canonicalKey` also does is unneeded weight for a leaf this
 * small.
 *
 * Throws after {@link MAX_COLLISION_ATTEMPTS} suffixed attempts are all
 * taken — a caller hitting that is proposing dozens of same-titled lessons on
 * the same day, which is a caller to stop and report, not to keep counting
 * past.
 */
export function lessonPath(
	title: string,
	date: Date,
	taken: ReadonlySet<string>,
): string {
	const iso = date.toISOString().slice(0, 10);
	const slug = lessonSlug(title);
	const takenLower = new Set([...taken].map((path) => path.toLowerCase()));
	const isTaken = (path: string) => takenLower.has(path.toLowerCase());

	const base = `${LESSONS_DIR}/${iso}-${slug}.md`;
	if (!isTaken(base)) {
		return base;
	}
	for (let n = 2; n <= MAX_COLLISION_ATTEMPTS; n++) {
		const candidate = `${LESSONS_DIR}/${iso}-${slug}-${n}.md`;
		if (!isTaken(candidate)) {
			return candidate;
		}
	}
	throw new Error(
		`Could not find an unused path for lesson "${title}" on ${iso} after ${MAX_COLLISION_ATTEMPTS} attempts.`,
	);
}

/** A lesson's content, before it is rendered to the file's frontmatter + body markdown. */
export type LessonContent = {
	title: string;
	body: string;
	date: Date;
	relatedPaths: readonly string[];
};

/** Double-quotes a YAML scalar, escaping `\` and `"` (in that order, so escaping `\` first never re-escapes a quote it just introduced). */
function quoteYamlScalar(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The lesson file's whole content: frontmatter the parser in
 * `packages/instructions/src/frontmatter.ts` reads (`name`, `description`,
 * and — for `related` — an arbitrary key whose indented `- <path>` lines that
 * parser folds into one newline-joined string field, not a real YAML list;
 * nothing here depends on it being parsed as one), then the title as an H1
 * and the body.
 *
 * `related` is omitted entirely when there are no related paths, rather than
 * emitted as an empty list — an agent that has nothing to relate a lesson to
 * should not have to invent a placeholder to read the file back cleanly.
 */
export function renderLesson({
	title,
	body,
	date,
	relatedPaths,
}: LessonContent): string {
	const iso = date.toISOString().slice(0, 10);
	const trimmedBody = body.trim();
	// `.trim()` strips leading whitespace including newlines, so `trimmedBody`
	// starts on a non-blank character and this first line is never empty.
	// A CRLF body would otherwise leave a bare `\r` inside the quoted scalar,
	// which the frontmatter parser's line regex does not match.
	const firstLine = (trimmedBody.split("\n", 1)[0] ?? "").replace(/\r$/, "");
	const description = firstLine.slice(0, MAX_DESCRIPTION_LENGTH);

	const lines: string[] = [
		"---",
		`name: ${quoteYamlScalar(title)}`,
		`description: ${quoteYamlScalar(description)}`,
		`date: ${iso}`,
	];
	if (relatedPaths.length > 0) {
		lines.push("related:");
		for (const path of relatedPaths) {
			lines.push(`  - ${path}`);
		}
	}
	lines.push("---", "", `# ${title}`, "", trimmedBody);

	return `${lines.join("\n")}\n`;
}
