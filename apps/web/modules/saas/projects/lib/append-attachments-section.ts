// MIRROR of `packages/api/modules/projects/lib/append-attachments-section.ts`.
// Keep both in sync. See spec § 8.2 / Task 1.5 of the chat-thread image-attachments feature.
//
// The server-side copy exists so `attach-pending-media-to-story.ts` (in
// `@repo/api`) can import the helper without depending on `apps/web` (the
// workspace DAG forbids that edge).

/**
 * Append a structured `## Attachments` markdown block to a UserStory
 * description. The keys appear inside markdown image syntax —
 * `![name](story-media/...)` — so `extractStoryMediaKeysFromContent` picks
 * them up via the bare-URL regex (the heading itself is decorative).
 */

import { stripInlineDecoration } from "@repo/utils/markdown-heading";

export interface UploadedAttachment {
	s3Key: string;
	name: string;
}

const ATTACHMENTS_HEADING = "## Attachments";

/**
 * Does `target` already carry an `## Attachments` section?
 *
 * A whole-document `target.includes(ATTACHMENTS_HEADING)` misses the heading
 * the moment the editor decorates it — highlighting it emits
 * `## <mark data-color="…">Attachments</mark>`, bolding it emits
 * `## **Attachments**` — and the caller then creates a SECOND section on every
 * append. So scan line by line and normalize each line first
 * (`stripInlineDecoration` is match-only; the original text is what gets
 * written back).
 *
 * The predicate is deliberately `includes`, not equality: `### Attachments`
 * literally contains `## Attachments`, so a DEMOTED heading — a common AI edit
 * in this codebase — counts as an existing section, exactly as it does today
 * with the raw `.includes()`. Tightening this to equality would narrow what
 * counts as existing and reintroduce the duplicate this function exists to
 * prevent.
 */
function hasAttachmentsHeading(target: string): boolean {
	return target
		.split("\n")
		.some((line) =>
			stripInlineDecoration(line).includes(ATTACHMENTS_HEADING),
		);
}

/**
 * Locate a trailing "View in Fabric" back-link (HTML anchor or — for Fizzy —
 * markdown-link form). `createStory`/`placeFabricBackLink` write this anchor at
 * the end of the description BEFORE attachments are appended, so a naive
 * end-append lands the images BELOW "View in Fabric" in the rendered card. We
 * splice the `## Attachments` block in just before the back-link instead, so
 * the images sit ABOVE it — matching what the PM push (`buildStoryDescription`)
 * already produces and mirroring `appendAdoAttachmentLinks` in
 * `pull-image-ingest.ts`. Only the back-link's START offset is used.
 */
const FABRIC_BACK_LINK_RE =
	/(?:<p[^>]*>\s*)?(?:<a\b[^>]*>\s*View in Fabric\s*<\/a>|\[View in Fabric\]\([^)]*\))/i;

function sanitizeName(name: string, fallbackIndex: number): string {
	const cleaned = name.replace(/[[\]()\n\r]/g, " ").trim();
	return cleaned.length > 0 ? cleaned : `Attachment ${fallbackIndex}`;
}

function renderEntry(att: UploadedAttachment, index: number): string {
	return `![${sanitizeName(att.name, index + 1)}](${att.s3Key})`;
}

/**
 * Merge the rendered entries into `target` — appending under an existing
 * `## Attachments` heading or creating one. `target` is either the full
 * description (no back-link) or the head portion before the back-link.
 */
function mergeEntriesInto(target: string, entries: string): string {
	if (hasAttachmentsHeading(target)) {
		const trailing = target.endsWith("\n") ? "" : "\n";
		return `${target}${trailing}${entries}\n`;
	}

	const separator =
		target.length === 0 ? "" : target.endsWith("\n") ? "\n" : "\n\n";
	return `${target}${separator}${ATTACHMENTS_HEADING}\n\n${entries}\n`;
}

export function appendAttachmentsSection(
	description: string,
	uploaded: readonly UploadedAttachment[],
): string {
	if (uploaded.length === 0) {
		return description;
	}

	// Idempotency: skip keys already referenced anywhere in description
	// (catches both the `## Attachments` section form and inline images).
	const fresh = uploaded.filter(
		(att) => !description.includes(`](${att.s3Key})`),
	);
	if (fresh.length === 0) {
		return description;
	}

	const entries = fresh.map(renderEntry).join("\n");

	// Splice the block in BEFORE a trailing "View in Fabric" back-link so the
	// images render above it; otherwise append at the end (unchanged behaviour).
	const backLink = FABRIC_BACK_LINK_RE.exec(description);
	if (backLink) {
		const head = description.slice(0, backLink.index).replace(/\s+$/, "");
		const tail = description.slice(backLink.index);
		return `${mergeEntriesInto(head, entries)}\n${tail}`;
	}

	return mergeEntriesInto(description, entries);
}
