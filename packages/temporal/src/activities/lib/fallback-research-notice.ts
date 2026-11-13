/**
 * The research notice the gateway fallback is told to write.
 *
 * The agent adds these notices itself, from the research it did or was not
 * allowed to do. The fallback writes the document without tools and without
 * any research outcome, so without these instructions the notice would vanish
 * exactly when the agent failed.
 *
 * A notice is written only where the choice was offered: a run that carries
 * no boolean (background, bulk and API runs) gets none, as before.
 */

/** For a run a person allowed to research: the research could not run. */
export const FALLBACK_RESEARCH_INCOMPLETE_INSTRUCTION =
	"External research could not run for this generation. Do not cite external sources and do not present external statistics, benchmarks or studies as verified evidence. If the document's own instructions or the user's message ask for external research, external data, benchmarks or published sources, open the document, directly after its H1 title, with a Markdown blockquote of plain paragraphs that starts with the bold label **Research incomplete.** and says that external research could not run for this generation, then names the missing evidence in a sentence that starts with \"Evidence gaps:\". Never state or imply that research was done. If nothing asked for external research, add no notice and do not mention research.";

/** For a run whose person was offered research and did not allow it. */
export const FALLBACK_RESEARCH_NOT_AUTHORIZED_INSTRUCTION =
	"External research was not authorized for this generation. If the document's own instructions or the user's message ask for external research, external data, benchmarks or published sources, write the document from the internal project context only and open it, directly after its H1 title, with a Markdown blockquote of plain paragraphs that starts with the bold label **External research not authorized.** and says that external research was not authorized for this generation, so the research requirement was not fulfilled, and that the draft uses internal project context only. Do not imply that research happened, and do not add links to external sources that are not in the provided project context. If nothing asked for external research, add no notice and do not mention research.";

/**
 * The fallback's system prompt: the run's own, if any, followed by the notice
 * that matches the run's answer — `true` the research-incomplete notice,
 * `false` the not-authorized one. Anything else is a run that offered no
 * choice, and its system prompt is returned exactly as given.
 */
export function withFallbackResearchNotice(
	systemPrompt: string | undefined,
	allowWebResearch: boolean | undefined,
): string | undefined {
	if (allowWebResearch !== true && allowWebResearch !== false) {
		return systemPrompt;
	}
	const notice = allowWebResearch
		? FALLBACK_RESEARCH_INCOMPLETE_INSTRUCTION
		: FALLBACK_RESEARCH_NOT_AUTHORIZED_INSTRUCTION;
	return systemPrompt ? `${systemPrompt}\n\n${notice}` : notice;
}
