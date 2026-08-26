/**
 * Server-side mirror of the FE `story-to-markdown` helpers, used by the
 * bulk-download procedure (`projects.stories.createBatchDownloadUrl`).
 *
 * The FE module at
 * `apps/web/modules/saas/projects/lib/stories/story-to-markdown.ts` is the
 * canonical implementation; this file replicates the behaviour with a
 * structural input type so the server doesn't need to depend on `apps/web`.
 *
 * Pure — no I/O, no React, no Next, no DOM. The two helpers MUST stay
 * behaviour-compatible with the FE versions; both files share the same
 * fixture / spec-fidelity tests in their colocated `__tests__` folders.
 */

export interface StoryDownloadProjectRef {
	name: string;
}

interface StoryDownloadTaskInput {
	identifier: string | null;
	title: string;
	isCompleted: boolean;
	order?: number | null;
}

export interface StoryDownloadStoryInput {
	identifier: string;
	title: string;
	description: string | null;
	acceptanceCriteria: string | null;
	priority: string | null;
	size: string | null;
	draftingStage: string;
	tasks: ReadonlyArray<StoryDownloadTaskInput>;
}

export interface SerializeStoryOptions {
	/** ISO date string used in the footer. Caller injects so output is deterministic. */
	generatedAt: string;
}

/**
 * Returns `true` when the trimmed text content of an HTML / Markdown string
 * is empty — i.e. when stripping tags and collapsing whitespace yields "".
 */
function isContentEmpty(value: string | null | undefined): boolean {
	if (value === null || value === undefined) {
		return true;
	}
	const stripped = value
		.replace(/<[^>]*>/g, "")
		.replace(/&nbsp;/gi, " ")
		.replace(/\s+/g, " ")
		.trim();
	return stripped.length === 0;
}

/**
 * Stub when ANY of:
 *   - story.draftingStage === "PLACEHOLDER"
 *   - tasks.length === 0 AND description and acceptanceCriteria are both empty/null
 *
 * Mirrors the FE truth-table contract; see
 * `apps/web/modules/saas/projects/lib/stories/__tests__/story-to-markdown.test.ts`.
 */
export function isStoryStub(story: StoryDownloadStoryInput): boolean {
	if (story.draftingStage === "PLACEHOLDER") {
		return true;
	}
	const descEmpty = isContentEmpty(story.description);
	const acEmpty = isContentEmpty(story.acceptanceCriteria);
	if (story.tasks.length === 0 && descEmpty && acEmpty) {
		return true;
	}
	return false;
}

/**
 * Map a `StoryPriority` enum value to a human-readable label. Mirrors
 * `getPriorityLabel` in
 * `apps/web/modules/saas/projects/lib/stories/types.ts`. The labels are
 * intentionally identical so a feature exported via the per-feature dropdown
 * (FE) renders the same Markdown as the bulk procedure (BE).
 */
function getPriorityLabel(priority: string | null | undefined): string | null {
	switch (priority) {
		case "P0_CRITICAL":
			return "P0 - Critical";
		case "P1_HIGH":
			return "P1 - High";
		case "P2_MEDIUM":
			return "P2 - Medium";
		case "P3_LOW":
			return "P3 - Low";
		default:
			return priority ?? null;
	}
}

/** Map a `StorySize` enum to a label. Returns `null` when size is unset. */
function getSizeLabel(size: string | null | undefined): string | null {
	if (!size) {
		return null;
	}
	return size; // The FE label maps each size value to itself ("XS", "S", …).
}

function formatChipLine(story: StoryDownloadStoryInput): string | null {
	const chips: string[] = [];
	const priorityLabel = getPriorityLabel(story.priority);
	if (priorityLabel) {
		chips.push(`**Priority:** ${priorityLabel}`);
	}
	const sizeLabel = getSizeLabel(story.size);
	if (sizeLabel) {
		chips.push(`**Size:** ${sizeLabel}`);
	}
	if (chips.length === 0) {
		return null;
	}
	return chips.join(" · ");
}

function formatTasksSection(story: StoryDownloadStoryInput): string | null {
	if (!story.tasks || story.tasks.length === 0) {
		return null;
	}
	const lines = story.tasks.map((task) => {
		const box = task.isCompleted ? "[x]" : "[ ]";
		const idPrefix = task.identifier ? `${task.identifier} ` : "";
		return `- ${box} ${idPrefix}${task.title}`;
	});
	return lines.join("\n");
}

/**
 * Serialize a UserStory + its tasks into Markdown per spec §3.1 / D6.
 * Empty optional sections are omitted; the footer is always rendered.
 */
export function serializeStoryToMarkdown(
	story: StoryDownloadStoryInput,
	project: StoryDownloadProjectRef,
	opts: SerializeStoryOptions,
): string {
	const sections: string[] = [];

	sections.push(`# ${story.identifier} — ${story.title}`);

	const chips = formatChipLine(story);
	if (chips) {
		sections.push(chips);
	}

	if (!isContentEmpty(story.description)) {
		sections.push(`## Description\n\n${(story.description ?? "").trim()}`);
	}

	if (!isContentEmpty(story.acceptanceCriteria)) {
		sections.push(
			`## Acceptance Criteria\n\n${(story.acceptanceCriteria ?? "").trim()}`,
		);
	}

	const tasks = formatTasksSection(story);
	if (tasks) {
		sections.push(`## Tasks\n\n${tasks}`);
	}

	sections.push(
		`---\n\n*Generated on ${opts.generatedAt} · ${project.name}*`,
	);

	return `${sections.join("\n\n")}\n`;
}

/**
 * Slugify a free-text identifier-or-title pair into a filename-safe stem.
 * Mirrors `toSlug` in
 * `apps/web/modules/saas/projects/lib/markdown-to-document.ts`.
 */
export function toStorySlug(input: string): string {
	return (
		input
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 80) || "feature"
	);
}
