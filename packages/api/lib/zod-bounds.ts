/**
 * Upper bounds for user-typed procedure inputs.
 *
 * Almost every `z.string()` in the API accepted any length, and every
 * `z.array()` any count. The database columns behind them are `text` and
 * `jsonb`, so nothing downstream refused either: a single request could carry
 * a multi-megabyte "title", and a chat message could carry a novel straight
 * into a model call and its token bill. These are abuse ceilings, sized well
 * above anything a person types, not product limits — a field with a real
 * product limit (a 255-character name, a 500-character change note) keeps its
 * own tighter `.max()`.
 *
 * Document CONTENT is deliberately not here. `projects.updateDocument` and
 * `documents.updateWithContext` accept unbounded content today, real
 * documents are large, and no bound has been established that is known to be
 * safe for the largest existing one.
 */

import { z } from "zod";

export const INPUT_BOUNDS = {
	/** Titles, names, labels, categories, search queries. */
	name: 500,
	/** Descriptions, goals, notes — a paragraph or a few. */
	description: 10_000,
	/** Anything sent to a model or stored as a body: chat messages, prompt
	 *  text, system prompts, work-item descriptions written in the editor. */
	text: 200_000,
	/** Identifiers or tags named in one request. */
	idArray: 500,
} as const;

/** An array of identifiers, capped at {@link INPUT_BOUNDS.idArray}. */
export function idArray(max: number = INPUT_BOUNDS.idArray) {
	return z.array(z.string()).max(max);
}

/** An array of short free-text items (tags, tech stack entries), each capped
 *  at {@link INPUT_BOUNDS.name} and the array at {@link INPUT_BOUNDS.idArray}. */
export function labelArray(max: number = INPUT_BOUNDS.idArray) {
	return z.array(z.string().max(INPUT_BOUNDS.name)).max(max);
}
