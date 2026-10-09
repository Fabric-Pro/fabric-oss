/**
 * Which open editor writes a regenerated body into a shared collaborative
 * document (Fizzy #2801).
 *
 * An editor attached to a run it did not start adopts the run's body when
 * the run completes. Under collaboration every open editor shares one Yjs
 * document, and two editors setting the same body at once each insert it, so
 * the shared document would hold it twice. Each editor therefore publishes
 * in its awareness state whether it started the run or is attached to one,
 * and exactly one writes the body:
 *
 * - the editor that started the run, which writes it through its own review,
 *   so no attached editor writes while that editor is in the room;
 * - otherwise the attached editor with the smallest awareness client id.
 *
 * The others take the body through the room's sync. Without an awareness
 * there is no shared document, and every editor writes its own.
 */

/** The awareness state field each editor publishes its run role in. */
export const GENERATION_RUN_AWARENESS_FIELD = "generationRun";

/**
 * `started`: this editor started the run and reviews its body. `attached`:
 * this editor follows a run it did not start and adopts its body.
 */
export type GenerationRunRole = "started" | "attached";

/** The part of a y-protocols `Awareness` the election reads and writes. */
interface GenerationRunAwareness {
	clientID: number;
	getStates(): Map<number, Record<string, unknown>>;
	getLocalState(): Record<string, unknown> | null;
	setLocalStateField(field: string, value: unknown): void;
}

/**
 * Publish this editor's run role, or clear it with `null`. Sends nothing
 * when the published role is already the one asked for, so other editors
 * never see a role flicker off and back on.
 */
export function publishGenerationRunRole(
	awareness: GenerationRunAwareness | null | undefined,
	role: GenerationRunRole | null,
): void {
	if (!awareness) {
		return;
	}
	const published =
		awareness.getLocalState()?.[GENERATION_RUN_AWARENESS_FIELD] ?? null;
	if (published === role) {
		return;
	}
	awareness.setLocalStateField(GENERATION_RUN_AWARENESS_FIELD, role);
}

/**
 * Whether this attached editor is the one that writes the run's body into
 * the shared document. It counts itself as attached whether or not its own
 * state has reached the room yet.
 */
export function appliesAttachedRunBody(
	awareness: GenerationRunAwareness | null | undefined,
): boolean {
	if (!awareness) {
		return true;
	}
	const own = awareness.clientID;
	let elected = own;
	for (const [clientId, state] of awareness.getStates()) {
		if (clientId === own) {
			continue;
		}
		const role = state?.[GENERATION_RUN_AWARENESS_FIELD];
		if (role === "started") {
			return false;
		}
		if (role === "attached" && clientId < elected) {
			elected = clientId;
		}
	}
	return elected === own;
}
