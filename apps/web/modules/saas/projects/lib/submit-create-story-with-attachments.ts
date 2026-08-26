import { appendAttachmentsSection } from "./append-attachments-section";
import type { CreateStoryInput } from "./stories/types";
import type {
	PendingDocAttachment,
	StoryAttachmentDesignation,
} from "./text-attachment-validation";

interface CreatedStoryShape {
	id: string;
	titleSource?: string | null;
}

interface SubmitCreateStoryDeps {
	createStoryMutateAsync: (
		input: CreateStoryInput & { organizationId: string | null },
	) => Promise<{ story: CreatedStoryShape; aiGenerated: boolean }>;
	uploadStoryImage: (params: {
		file: File;
		projectId: string;
		userStoryId: string;
		organizationId: string | null;
	}) => Promise<string>;
	/**
	 * Uploads a first-class doc attachment (StoryAttachment row). Required (not
	 * optional) so a caller that supplies `docAttachments` can never omit the
	 * upload path and silently drop files — TypeScript forces the wire-up.
	 * Returns the persisted row's id.
	 */
	uploadStoryAttachment: (params: {
		file: File;
		projectId: string;
		userStoryId: string;
		organizationId: string | null;
		designation: StoryAttachmentDesignation;
	}) => Promise<{ id: string }>;
	updateStoryMutateAsync: (input: {
		projectId: string;
		storyId: string;
		organizationId: string | null;
		description: string;
	}) => Promise<unknown>;
	closeDialog: () => void;
	toast: {
		success: (m: string) => void;
		error: (m: string) => void;
		warning: (m: string) => void;
	};
}

export interface SubmitCreateStoryArgs {
	data: CreateStoryInput;
	files: File[];
	/**
	 * First-class text attachments (.docx/.md/.txt) staged in the create dialog,
	 * each with its designation. Uploaded as StoryAttachment rows — never patched
	 * into the description. Defaults to empty (image-only flow unchanged).
	 */
	docAttachments?: PendingDocAttachment[];
	organizationId: string | null;
	deps: SubmitCreateStoryDeps;
}

export interface SubmitCreateStoryResult {
	titleSource: string | null;
	/**
	 * The newly-created story's id. Exposed so the caller can defer navigation
	 * until AFTER the full create → upload → updateStory pipeline resolves
	 * (Codex review of PR 1 caught the Roadmap race where router.push lived
	 * inside createStoryMutation.onSuccess and fired before uploads finished).
	 */
	storyId: string;
}

/**
 * Orchestrates the deferred-upload flow for creating a UserStory with image
 * AND first-class doc (.docx/.md/.txt) attachments:
 *
 *   1. createStory → { story, aiGenerated }
 *   2. doc attachments: for each, uploadStoryAttachment → StoryAttachment row
 *      (Promise.allSettled). These are NEVER patched into the description.
 *   3. image attachments: for each, uploadStoryImage → s3Key (Promise.allSettled)
 *   4. if any image uploaded: updateStory with description patched via
 *      appendAttachmentsSection
 *   5. closeDialog (only after the upload/patch pipeline resolves; this is the
 *      ordering contract that the tests pin).
 *
 * Failure modes:
 *   - createStory throws → propagate (caller's toast lifecycle handles it).
 *   - Some/all doc uploads fail → toast.warning, feature still created; docs are
 *     independent of the image path and never block it. Orphaned R2 objects are
 *     reclaimed by the always-on retention/orphan-sweep jobs.
 *   - All image uploads fail → toast.error, dialog closes, no description patch.
 *   - Some image uploads fail → toast.warning, description patched with the
 *     successful subset.
 *   - updateStory throws after successful image uploads → toast.error, dialog
 *     closes, S3 objects remain orphaned under story-media/{projectId}/{storyId}/.
 */
export async function submitCreateStoryWithAttachments(
	args: SubmitCreateStoryArgs,
): Promise<SubmitCreateStoryResult> {
	const { data, files, organizationId, deps } = args;
	const docAttachments = args.docAttachments ?? [];

	const createResult = await deps.createStoryMutateAsync({
		...data,
		organizationId,
	});
	const story = createResult.story;

	// Upload first-class doc attachments (StoryAttachment rows) before any
	// closeDialog, preserving the ordering contract. Independent of the image
	// path; never patches the description. Partial failures warn but never block
	// the created feature.
	if (docAttachments.length > 0) {
		const docResults = await Promise.allSettled(
			docAttachments.map((doc) =>
				deps.uploadStoryAttachment({
					file: doc.file,
					projectId: data.projectId,
					userStoryId: story.id,
					organizationId,
					designation: doc.designation,
				}),
			),
		);
		const docFailed = docResults.filter(
			(r) => r.status === "rejected",
		).length;
		if (docFailed > 0) {
			const docOk = docAttachments.length - docFailed;
			deps.toast.warning(
				docOk > 0
					? `${docOk} of ${docAttachments.length} documents attached — open the feature to retry the rest.`
					: `Feature created but ${docFailed} document(s) failed to attach. Open the feature to retry.`,
			);
		}
	}

	if (files.length === 0) {
		deps.closeDialog();
		return { titleSource: story.titleSource ?? null, storyId: story.id };
	}

	const uploadResults = await Promise.allSettled(
		files.map(async (file) => {
			const s3Key = await deps.uploadStoryImage({
				file,
				projectId: data.projectId,
				userStoryId: story.id,
				organizationId,
			});
			return { s3Key, name: file.name };
		}),
	);

	const uploaded = uploadResults
		.filter(
			(r): r is PromiseFulfilledResult<{ s3Key: string; name: string }> =>
				r.status === "fulfilled",
		)
		.map((r) => r.value);
	const failedCount = uploadResults.length - uploaded.length;

	if (uploaded.length === 0) {
		deps.toast.error(
			failedCount > 0
				? `Story created but ${failedCount} attachment(s) failed to upload. Open the story to retry.`
				: "Story created with no attachments.",
		);
		deps.closeDialog();
		return { titleSource: story.titleSource ?? null, storyId: story.id };
	}

	const patchedDescription = appendAttachmentsSection(
		data.description ?? "",
		uploaded,
	);
	try {
		await deps.updateStoryMutateAsync({
			projectId: data.projectId,
			storyId: story.id,
			organizationId,
			description: patchedDescription,
		});
	} catch {
		deps.toast.error(
			"Story created, but attachments couldn't be linked. Open the story to fix.",
		);
		deps.closeDialog();
		return { titleSource: story.titleSource ?? null, storyId: story.id };
	}

	if (failedCount > 0) {
		deps.toast.warning(
			`${uploaded.length} of ${files.length} attachments uploaded — open the story to retry the rest.`,
		);
	}

	deps.closeDialog();
	return { titleSource: story.titleSource ?? null, storyId: story.id };
}
