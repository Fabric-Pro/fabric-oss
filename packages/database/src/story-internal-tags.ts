/**
 * Fabric-internal story tags versus PM-tool labels.
 *
 * `UserStory.labels` is the PM-tool label set: the GitLab/Jira sync pushes it
 * outward and full-sets it on create. Scope intake and the roadmap need
 * grouping markers that must NOT leave Fabric — the quoted phase
 * (`phase:N`), the customer's functional area (`area:<name>`) and the
 * proposal priority band (`priority:must|nice`). Those live as `StoryTag`
 * rows, which the roadmap, the estimate export and the classifier read.
 *
 * `createStory` splits an incoming label list with this helper so every
 * caller (scope intake, proposal apply, the Teams approve path) can keep
 * passing one `labels` array and still end up with the right storage.
 * Pure — no Prisma import — so client bundles can share the prefixes.
 */

export const INTERNAL_STORY_TAG_PREFIXES = [
	"phase:",
	"area:",
	"priority:",
] as const;

export function isInternalStoryTag(value: string): boolean {
	const v = value.trim();
	return INTERNAL_STORY_TAG_PREFIXES.some((p) => v.startsWith(p));
}

/** Partition a label list into PM-tool labels and Fabric-internal tags. */
export function splitInternalStoryTags(
	labels: readonly string[] | null | undefined,
): { labels: string[]; tags: string[] } {
	const out = { labels: [] as string[], tags: [] as string[] };
	for (const raw of labels ?? []) {
		const value = raw.trim();
		if (!value) {
			continue;
		}
		const bucket = isInternalStoryTag(value) ? out.tags : out.labels;
		if (!bucket.includes(value)) {
			bucket.push(value);
		}
	}
	return out;
}

/** Labels and tags merged back into one list for readers of `phase:`/`area:`. */
export function mergeStoryMarkers(
	labels: readonly string[] | null | undefined,
	tags: readonly { value: string }[] | readonly string[] | null | undefined,
): string[] {
	const values = (tags ?? []).map((t) =>
		typeof t === "string" ? t : t.value,
	);
	return Array.from(new Set([...(labels ?? []), ...values]));
}
