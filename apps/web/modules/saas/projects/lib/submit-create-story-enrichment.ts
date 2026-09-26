import { appendAttachmentsSection } from "./append-attachments-section";
import type { PendingDocAttachment } from "./text-attachment-validation";

/**
 * The dependencies this orchestrator needs, kept as a SUBSET of
 * `SubmitCreateStoryDeps` (`submit-create-story-with-attachments.ts`) so both
 * paths call the exact same upload functions with the exact same shapes —
 * only `createStoryMutateAsync` and `closeDialog` are absent, because
 * enriching writes to an EXISTING ticket rather than creating one, and
 * closing the dialog is the caller's job once this resolves.
 */
export interface SubmitEnrichStoryDeps {
	uploadStoryImage: (params: {
		file: File;
		projectId: string;
		userStoryId: string;
		organizationId: string | null;
	}) => Promise<string>;
	uploadStoryAttachment: (params: {
		file: File;
		projectId: string;
		userStoryId: string;
		organizationId: string | null;
		designation: PendingDocAttachment["designation"];
	}) => Promise<{ id: string }>;
	updateStoryMutateAsync: (input: {
		projectId: string;
		storyId: string;
		organizationId: string | null;
		description: string;
		acceptanceCriteria?: string;
	}) => Promise<unknown>;
	toast: {
		success: (m: string) => void;
		error: (m: string) => void;
		warning: (m: string) => void;
	};
}

export interface SubmitEnrichStoryArgs {
	projectId: string;
	targetStoryId: string;
	targetIdentifier: string;
	/** The structure-preserving merge's result, from `previewEnrichment`. */
	mergedDescription: string;
	mergedAcceptanceCriteria: string;
	/** Whether the merge actually changed acceptance criteria — omitted from
	 * the write when it did not, so a no-op field is never re-sent. */
	acceptanceCriteriaChanged: boolean;
	files: File[];
	docAttachments?: PendingDocAttachment[];
	organizationId: string | null;
	deps: SubmitEnrichStoryDeps;
}

export interface SubmitEnrichStoryResult {
	storyId: string;
}

/**
 * Orchestrates confirming a duplicate-warning enrichment from the roadmap
 * create dialog (Fizzy #2180): upload doc + image attachments to the TARGET
 * ticket (never to the abandoned draft), fold uploaded images into the
 * merged description via the SAME `appendAttachmentsSection` helper the
 * create path uses, and commit the merge and the attachments in ONE
 * `stories.update` call — so a reader never sees the merged body land
 * without its attachments, or the reverse.
 *
 * Ordering mirrors `submitCreateStoryWithAttachments`: docs first
 * (`Promise.allSettled`, independent of the image path, partial failure
 * warns but never blocks), then images, then the single write. Unlike that
 * orchestrator this one has no "created" row to fall back on — a failed
 * `stories.update` means NOTHING was written to the target, so the caller's
 * `onError` must say the update did not land rather than treating it as a
 * partial success.
 */
export async function submitCreateStoryEnrichment(
	args: SubmitEnrichStoryArgs,
): Promise<SubmitEnrichStoryResult> {
	const {
		projectId,
		targetStoryId,
		targetIdentifier,
		mergedDescription,
		mergedAcceptanceCriteria,
		acceptanceCriteriaChanged,
		files,
		organizationId,
		deps,
	} = args;
	const docAttachments = args.docAttachments ?? [];

	if (docAttachments.length > 0) {
		const docResults = await Promise.allSettled(
			docAttachments.map((doc) =>
				deps.uploadStoryAttachment({
					file: doc.file,
					projectId,
					userStoryId: targetStoryId,
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
					? `${docOk} of ${docAttachments.length} documents attached to ${targetIdentifier} — open it to retry the rest.`
					: `${targetIdentifier} updated, but ${docFailed} document(s) failed to attach. Open it to retry.`,
			);
		}
	}

	let description = mergedDescription;
	let imageFailedCount = 0;
	if (files.length > 0) {
		const uploadResults = await Promise.allSettled(
			files.map(async (file) => {
				const s3Key = await deps.uploadStoryImage({
					file,
					projectId,
					userStoryId: targetStoryId,
					organizationId,
				});
				return { s3Key, name: file.name };
			}),
		);
		const uploaded = uploadResults
			.filter(
				(
					r,
				): r is PromiseFulfilledResult<{
					s3Key: string;
					name: string;
				}> => r.status === "fulfilled",
			)
			.map((r) => r.value);
		imageFailedCount = uploadResults.length - uploaded.length;
		if (uploaded.length > 0) {
			description = appendAttachmentsSection(mergedDescription, uploaded);
		}
	}

	// The one write that actually commits the enrichment. A throw here means
	// NOTHING landed on the target — the caller's `onError` must say so rather
	// than treating this as a partial success the way a failed image upload
	// above is treated.
	await deps.updateStoryMutateAsync({
		projectId,
		storyId: targetStoryId,
		organizationId,
		description,
		...(acceptanceCriteriaChanged
			? { acceptanceCriteria: mergedAcceptanceCriteria }
			: {}),
	});

	if (imageFailedCount > 0) {
		deps.toast.warning(
			`${imageFailedCount} attachment(s) failed to upload to ${targetIdentifier} — open it to retry.`,
		);
	}
	deps.toast.success(`${targetIdentifier} updated.`);

	return { storyId: targetStoryId };
}
