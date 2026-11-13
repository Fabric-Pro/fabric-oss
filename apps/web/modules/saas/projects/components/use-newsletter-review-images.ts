"use client";

import type { NewsletterImagePlacement } from "@repo/database/src/newsletter-schema";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { prepareNewsletterImage } from "../lib/newsletter-image-prepare";
import {
	describeImageFailure,
	describeImageRefusal,
	type NewsletterImageRefusalCode,
} from "./newsletter-review-feedback";

/** Same budget the Brand kit gives a signed PUT; images here are ≤300 KB. */
const UPLOAD_TIMEOUT_MS = 60_000;

type NewsletterImageUploadTarget =
	| { kind: "add"; highlightIndex: number }
	| { kind: "replace"; imageId: string };

interface NewsletterImagePatch {
	included?: boolean;
	altText?: string;
	placement?: NewsletterImagePlacement;
	highlightIndex?: number;
	position?: number;
}

/** A file the browser refused before anything was sent. */
class NewsletterImageRefused extends Error {
	readonly code: NewsletterImageRefusalCode;
	constructor(code: NewsletterImageRefusalCode) {
		super(code);
		this.code = code;
	}
}

/**
 * Every image write of the review dialog: upload (add or replace), edit,
 * include all, remove, capture again and capture from a description. Each
 * success asks the owner to refetch the pending list, which also re-signs
 * the image URLs and shows a capture in progress. A CONFLICT (the send left
 * review) is reported
 * once and handed to `onConflict`, which refetches and closes the dialog.
 */
export function useNewsletterReviewImages({
	projectId,
	organizationId,
	sendId,
	onChanged,
	onConflict,
}: {
	projectId: string;
	organizationId: string | null;
	sendId: string;
	onChanged: () => void;
	onConflict: () => void;
}) {
	const scope = { projectId, organizationId };

	const handleFailure = (error: unknown) => {
		if (error instanceof NewsletterImageRefused) {
			toast.error(describeImageRefusal(error.code));
			return;
		}
		const feedback = describeImageFailure(error);
		if (feedback.level === "info") {
			toast.info(feedback.message);
		} else {
			toast.error(feedback.message);
		}
		if (feedback.refresh) {
			onConflict();
		}
	};

	const upload = useMutation({
		mutationFn: async ({
			file,
			target,
		}: {
			file: File;
			target: NewsletterImageUploadTarget;
		}) => {
			const prepared = await prepareNewsletterImage(file);
			if (!prepared.ok) {
				throw new NewsletterImageRefused(prepared.code);
			}
			const { signedUploadUrl, uploadToken } =
				await orpcClient.newsletter.sends.images.createUploadUrl({
					...scope,
					sendId,
					contentType: prepared.contentType,
					contentLength: prepared.file.size,
				});
			const response = await fetch(signedUploadUrl, {
				method: "PUT",
				body: prepared.file,
				headers: { "Content-Type": prepared.contentType },
				signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
			});
			if (!response.ok) {
				throw new Error("Newsletter image upload failed");
			}
			const dimensions = {
				width: prepared.width,
				height: prepared.height,
			};
			if (target.kind === "add") {
				return orpcClient.newsletter.sends.images.add({
					...scope,
					sendId,
					highlightIndex: target.highlightIndex,
					uploadToken,
					...dimensions,
				});
			}
			return orpcClient.newsletter.sends.images.replace({
				...scope,
				imageId: target.imageId,
				uploadToken,
				...dimensions,
			});
		},
		onSuccess: onChanged,
		onError: handleFailure,
	});

	const update = useMutation({
		mutationFn: ({
			imageId,
			patch,
		}: {
			imageId: string;
			patch: NewsletterImagePatch;
		}) =>
			orpcClient.newsletter.sends.images.update({
				...scope,
				imageId,
				...patch,
			}),
		onSuccess: onChanged,
		onError: handleFailure,
	});

	const includeAll = useMutation({
		mutationFn: (removedHighlightIndexes: number[]) =>
			orpcClient.newsletter.sends.images.includeAll({
				...scope,
				sendId,
				removedHighlightIndexes,
			}),
		onSuccess: onChanged,
		onError: handleFailure,
	});

	const remove = useMutation({
		mutationFn: (imageId: string) =>
			orpcClient.newsletter.sends.images.remove({ ...scope, imageId }),
		onSuccess: () => {
			toast.success("Image removed");
			onChanged();
		},
		onError: handleFailure,
	});

	const regenerate = useMutation({
		mutationFn: ({
			imageId,
			prompt,
		}: {
			imageId: string;
			prompt?: string;
		}) =>
			orpcClient.newsletter.sends.images.regenerate({
				...scope,
				imageId,
				prompt,
			}),
		onSuccess: onChanged,
		onError: handleFailure,
	});

	const capture = useMutation({
		mutationFn: ({
			highlightIndex,
			prompt,
		}: {
			highlightIndex: number;
			prompt: string;
		}) =>
			orpcClient.newsletter.sends.images.capture({
				...scope,
				sendId,
				highlightIndex,
				prompt,
			}),
		onSuccess: onChanged,
		onError: handleFailure,
	});

	return {
		uploadImage: (file: File, target: NewsletterImageUploadTarget) =>
			upload.mutate({ file, target }),
		updateImage: (imageId: string, patch: NewsletterImagePatch) =>
			update.mutate({ imageId, patch }),
		/** Include every ready image under the highlights still kept. */
		includeAllImages: (removedHighlightIndexes: number[]) =>
			includeAll.mutate(removedHighlightIndexes),
		removeImage: (imageId: string) => remove.mutate(imageId),
		/** Capture a captured image again, optionally with new words. */
		recaptureImage: (imageId: string, prompt?: string) =>
			regenerate.mutate({ imageId, prompt }),
		/** Capture a new screenshot for a highlight from a description. */
		captureImage: (highlightIndex: number, prompt: string) =>
			capture.mutate({ highlightIndex, prompt }),
		/** What is uploading right now, so its slot can show a spinner. */
		uploadingTarget: upload.isPending
			? (upload.variables?.target ?? null)
			: null,
		uploading: upload.isPending,
		busy:
			upload.isPending ||
			update.isPending ||
			includeAll.isPending ||
			remove.isPending ||
			regenerate.isPending ||
			capture.isPending,
	};
}
