import { updateStory as updateStoryBase } from "@repo/database";

/**
 * `updateStory` for the PM-sync activities.
 *
 * Everything these modules write to a story arrived from the PM tool, so the
 * resulting edit is attributed to that tool rather than to whoever happened to
 * trigger the sync — unless a caller names a more specific source. Without a
 * default the canonical boundary would reject these writes outright, since it
 * refuses to record a genuine edit anonymously.
 *
 * A leaf module: it imports only `@repo/database`, so the PM-sync activity
 * files can share it without closing an import cycle between them (the same
 * shape `reconcile-story-terminal-status.ts` uses for the same reason).
 *
 * Every parameter other than the edit context is forwarded verbatim, via a rest
 * spread rather than a named binding. The signature is spelled as
 * `Parameters<typeof updateStoryBase>`, so anything this wrapper accepts but
 * drops is discarded with no type error: a caller that passes its own `tx`
 * would silently get a separate self-transacting write and lose the row lock it
 * opened the transaction to hold. The spread also keeps the forwarded arity
 * equal to the received one — naming the trailing parameters would append an
 * explicit `undefined` for every caller that omits them, changing the observed
 * call shape for the callers that pass none.
 */
export async function updateStoryFromPm(
	...args: Parameters<typeof updateStoryBase>
) {
	const [storyId, projectId, data, context, ...rest] = args;
	return updateStoryBase(
		storyId,
		projectId,
		data,
		{
			...context,
			lastEditedSource: context?.lastEditedSource ?? "PM_PULL",
		},
		...rest,
	);
}
