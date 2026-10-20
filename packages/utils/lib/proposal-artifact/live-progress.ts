/**
 * The generation progress a coordinated Proposal run reports while its Main
 * is written (Fizzy #2801, #2946), shared by the worker that writes it, the
 * live query module that guards it and the page that reads it.
 *
 * `generationProgress` is the run's only state the page can read besides its
 * status and live sections, so a milestone is a fixed value, compared by
 * equality, never a range. The workflow writes 35 before the generation
 * activity starts and 80 once it has returned (`reportProgress` in
 * `document-generation-child.ts`); in between, only the activity writes, and
 * only {@link PROPOSAL_PREVIEW_STOPPED_PROGRESS}.
 *
 * Dependency-free on purpose, so the browser can import it.
 */

/** The agent is drafting: written before the generation activity starts. */
export const PROPOSAL_DRAFTING_PROGRESS = 35;

/**
 * The agent's stream has ended: visuals and the final save follow, so
 * nothing more is being written live.
 */
export const PROPOSAL_FINISHING_PROGRESS = 80;

/**
 * The live preview stopped before the run ended (a stream cut by its limits,
 * a provider error, a stream that ended without a document): the sections
 * written so far stay, the fallback generation writes the Main without a
 * preview, and the result may differ from them. Between
 * {@link PROPOSAL_DRAFTING_PROGRESS} and {@link PROPOSAL_FINISHING_PROGRESS},
 * and a value the workflow never writes, so the page can tell it apart. A
 * later attempt's claim of the run puts {@link PROPOSAL_DRAFTING_PROGRESS}
 * back.
 */
export const PROPOSAL_PREVIEW_STOPPED_PROGRESS = 50;
