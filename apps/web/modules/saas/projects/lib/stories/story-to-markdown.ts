/**
 * Pure helpers for the Feature Export / Download feature.
 *
 * `serializeStoryToMarkdown` produces the exact Markdown layout described in
 * spec §3.1 / decisions D6:
 *   1. Title line: `${identifier} — ${title}`
 *   2. Priority + Size chips line (chip omitted if value is null)
 *   3. ## Description (omitted if empty)
 *   4. ## Acceptance Criteria (omitted if empty)
 *   5. ## Tasks (checkbox list, omitted if no tasks)
 *   6. Footer: `*Generated on {generatedAt} · {project name}*`
 *
 * `isStoryStub` returns true when the feature has insufficient content to
 * export — defined purely as "no tasks AND empty description AND empty
 * acceptance criteria". `draftingStage` (e.g. PLACEHOLDER) is intentionally
 * not part of the predicate: a Placeholder-stage feature with rich content
 * is exportable; a Closed feature with no content is not. (HTML/Markdown
 * whitespace-only strings count as empty.)
 *
 * Pure functions — no React, no DOM, no Next, no `Date.now()`. Safe to
 * import from both `apps/web` (client component) and `packages/api`
 * (server-side bulk procedure).
 */

import { getPriorityLabel, getSizeLabel, type UserStory } from "./types";

export interface SerializeStoryOptions {
	/** ISO date string used in the footer. Caller injects so snapshots stay deterministic. */
	generatedAt: string;
}

export interface StoryProjectRef {
	name: string;
}

/**
 * Returns `true` when the trimmed text content of an HTML / Markdown string
 * is empty — i.e. when stripping tags and collapsing whitespace yields "".
 *
 * Examples that return true: `null`, `undefined`, `""`, `"   "`, `"<p></p>"`,
 * `"<p> </p>"`, `"<p><br/></p>"`. A string with any meaningful character
 * returns false.
 */
function isContentEmpty(value: string | null | undefined): boolean {
	if (value === null || value === undefined) {
		return true;
	}
	// Strip HTML tags then collapse whitespace; treat &nbsp; as whitespace.
	const stripped = value
		.replace(/<[^>]*>/g, "")
		.replace(/&nbsp;/gi, " ")
		.replace(/\s+/g, " ")
		.trim();
	return stripped.length === 0;
}

/**
 * Stub when the feature has NO usable content — i.e. no tasks AND both
 * `description` and `acceptanceCriteria` are empty. (HTML/Markdown
 * whitespace-only strings count as empty.)
 *
 * `draftingStage` is NOT consulted: a Placeholder-stage feature can carry
 * a full description, AC, and tasks (AI-suggestion flow, backlog grooming),
 * and a Closed feature can be the most polished. The toast shown when this
 * returns `true` literally tells the user "Add a description, acceptance
 * criteria, or tasks first" — so the predicate must match that copy and
 * fire only when those three are actually missing, regardless of stage.
 */
export function isStoryStub(story: UserStory): boolean {
	const descEmpty = isContentEmpty(story.description);
	const acEmpty = isContentEmpty(story.acceptanceCriteria);
	return story.tasks.length === 0 && descEmpty && acEmpty;
}

/** Format a chip line: only emit chips whose value is non-null. */
function formatChipLine(
	story: Pick<UserStory, "priority" | "size">,
): string | null {
	const chips: string[] = [];
	if (story.priority) {
		chips.push(`**Priority:** ${getPriorityLabel(story.priority)}`);
	}
	if (story.size) {
		chips.push(`**Size:** ${getSizeLabel(story.size)}`);
	}
	if (chips.length === 0) {
		return null;
	}
	return chips.join(" · ");
}

/** Render the tasks section as a checkbox list. */
function formatTasksSection(story: Pick<UserStory, "tasks">): string | null {
	if (!story.tasks || story.tasks.length === 0) {
		return null;
	}
	const lines = story.tasks.map((task: UserStory["tasks"][number]) => {
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
	story: UserStory,
	project: StoryProjectRef,
	opts: SerializeStoryOptions,
): string {
	const sections: string[] = [];

	// 1. Title
	sections.push(`# ${story.identifier} — ${story.title}`);

	// 2. Priority + Size chips
	const chips = formatChipLine(story);
	if (chips) {
		sections.push(chips);
	}

	// 3. Description
	if (!isContentEmpty(story.description)) {
		sections.push(`## Description\n\n${(story.description ?? "").trim()}`);
	}

	// 4. Acceptance Criteria
	if (!isContentEmpty(story.acceptanceCriteria)) {
		sections.push(
			`## Acceptance Criteria\n\n${(story.acceptanceCriteria ?? "").trim()}`,
		);
	}

	// 5. Tasks
	const tasks = formatTasksSection(story);
	if (tasks) {
		sections.push(`## Tasks\n\n${tasks}`);
	}

	// 6. Footer (always rendered)
	sections.push(
		`---\n\n*Generated on ${opts.generatedAt} · ${project.name}*`,
	);

	return `${sections.join("\n\n")}\n`;
}
