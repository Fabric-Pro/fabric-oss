/**
 * Whether saving this edit needs to warn that other actions take it too (FR21).
 *
 * A prompt's body is shared by every action bound to it, so an edit made while
 * looking at one action silently changes the others. The warning exists to stop
 * that being a surprise.
 *
 * Extracted from the save handler so the rule can be asserted directly. It has
 * three conditions and each is a decision someone could reasonably get wrong,
 * which is not something to leave inferred from a component test that mocks a
 * confirmation provider.
 */

export type SharedEditWarning = {
	title: string;
	message: string;
};

/**
 * Only interrupt when the edit actually reaches somewhere the user is not
 * looking:
 *
 *  - the CONTENT changed — a rename or a tag edit changes nothing any agent
 *    reads, so interrupting for it trains people to dismiss the dialog;
 *  - and MORE THAN ONE action is bound — with a single binding the reach is
 *    exactly the action on screen, and there is nothing to disclose.
 */
export function needsSharedEditWarning({
	contentChanged,
	boundActionCount,
}: {
	contentChanged: boolean;
	boundActionCount: number;
}): boolean {
	return contentChanged && boundActionCount > 1;
}

/**
 * Name the actions rather than counting them. "Used by 4 actions" tells the
 * reader to go and look; listing them lets them decide without leaving.
 */
export function sharedEditWarning(
	boundActionLabels: readonly string[],
): SharedEditWarning {
	return {
		title: "This prompt is used by several actions",
		message: `Saving changes the prompt for all ${
			boundActionLabels.length
		}: ${boundActionLabels.join(
			", ",
		)}. They share one body, so every one of them takes this edit.`,
	};
}
