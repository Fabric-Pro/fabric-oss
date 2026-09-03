/**
 * The untrusted-data fence shared by every Publishing Suite writer prompt that
 * has one (Fizzy #1854, Phase 2C).
 *
 * EXTRACTED from `publishing-case-study-prompt.ts` by slice 2 rather than
 * copied, and the reason is the header that file already carried: "the marker
 * and its escape live together on purpose. A delimiter defined in one file and
 * neutralized in another is a fence whose gate is somewhere else." A SECOND
 * prompt with its own pair of constants is the same defect one level up —
 * change the marker in one file and the other prompt's escape still guards the
 * old token, with nothing failing. So there is one definition, and both prompts
 * import it. `publishing-case-study-prompt.ts` re-exports these three names so
 * every 2C-1 importer keeps working unchanged.
 *
 * Anything that renders a value INTO a fenced template must put it through
 * `neutralizeSourceDataMarkers` first.
 */

/**
 * The opener every source block starts with. Each one carries its own label
 * after the colon, so this is a prefix rather than a whole marker.
 */
export const SOURCE_DATA_OPEN_PREFIX = "<<<SOURCE DATA:";

/** The one closer. Every block ends with exactly this. */
export const SOURCE_DATA_CLOSE_MARKER = "<<<END SOURCE DATA>>>";

/**
 * Text shaped like one of the two markers: a run of three or more angle
 * brackets sitting against the words "SOURCE DATA", in either arrangement.
 *
 * Deliberately narrow. Neutralizing every `<<<` and `>>>` would mangle content
 * we are given all the time — a Python doctest (`>>> import os`), a shell
 * here-string (`cat <<< "x"`), a pasted merge conflict (`<<<<<<< HEAD`) — and a
 * fence that visibly corrupts ordinary prose is one an org edits away. Neither
 * marker form can exist without the literal words next to the angles, so
 * matching on that pair is both sufficient and cheap.
 */
const MARKER_SHAPED_TEXT =
	/<{3,}\s*(?:end\s+)?source\s+data[^\n]{0,200}?>{3,}|<{3,}\s*(?:end\s+)?source\s+data|source\s+data[^\n]{0,200}?>{3,}/gi;

/** Break an angle run so it can no longer read as a delimiter: `<<<` → `< < <`. */
function spaceOutAngleRuns(text: string): string {
	return text.replace(/<{3,}|>{3,}/g, (run) => run.split("").join(" "));
}

/**
 * Make an untrusted value safe to interpolate between the markers.
 *
 * The fence is worth nothing without this. A pull request description, a
 * meeting transcript or a project document that contains the literal
 * `<<<END SOURCE DATA>>>` closes its own block early, and every line after it
 * re-enters the prompt as top-level text — which is exactly the instruction
 * channel the fence exists to deny. Nothing about that failure is visible: the
 * rendered prompt still looks well-formed, and the draft that comes back reads
 * like any other.
 *
 * NEUTRALIZE, never reject. A legitimate document that happens to quote the
 * token — a design note about this very prompt, say — must still generate. It
 * just cannot break out: spacing the angle run apart leaves every character
 * readable while destroying the delimiter, so the model still sees the sentence
 * and still sees it as source data.
 */
export function neutralizeSourceDataMarkers(value: string): string {
	return value.replace(MARKER_SHAPED_TEXT, spaceOutAngleRuns);
}
