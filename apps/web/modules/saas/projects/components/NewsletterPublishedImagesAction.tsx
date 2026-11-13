"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation } from "@tanstack/react-query";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@ui/components/alert-dialog";
import { toast } from "sonner";

const REMOVE_FAILED = "Could not remove the published images. Try again.";

function failureMessage(error: unknown): string {
	return error instanceof Error && error.message.trim()
		? error.message.trim()
		: REMOVE_FAILED;
}

function describeRemoval(imageCount: number): string {
	const [subject, pronoun] =
		imageCount === 1
			? ["This newsletter's image is", "It disappears"]
			: [`This newsletter's ${imageCount} images are`, "They disappear"];
	return `${subject} deleted from public storage. ${pronoun} from the emails that were already delivered, and from the release notes archive. This cannot be undone.`;
}

/**
 * Takes down the images a delivered newsletter published. Emails that were
 * already delivered point at those images, so they disappear from those
 * emails too; the confirmation says so before anything is removed.
 */
export function NewsletterPublishedImagesAction({
	projectId,
	organizationId,
	sendId,
	imageCount,
	onRemoved,
}: {
	projectId: string;
	organizationId: string | null;
	sendId: string;
	imageCount: number;
	onRemoved: () => void;
}) {
	const description = describeRemoval(imageCount);
	const noun = imageCount === 1 ? "image" : "images";
	const unpublish = useMutation({
		mutationFn: () =>
			orpcClient.newsletter.sends.images.unpublish({
				projectId,
				organizationId,
				sendId,
			}),
		onSuccess: ({ removed }) => {
			toast.success(
				removed === 1
					? "1 published image removed"
					: `${removed} published images removed`,
			);
			onRemoved();
		},
		onError: (error) => {
			toast.error(failureMessage(error));
			onRemoved();
		},
	});

	return (
		<AlertDialog>
			<AlertDialogTrigger asChild>
				<button
					type="button"
					disabled={unpublish.isPending}
					className="ml-2 underline underline-offset-2 hover:text-foreground disabled:opacity-50"
				>
					Remove published {noun}
				</button>
			</AlertDialogTrigger>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>
						Remove published {noun}?
					</AlertDialogTitle>
					<AlertDialogDescription>
						{description}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction
						variant="destructive"
						onClick={() => unpublish.mutate()}
					>
						Remove {noun}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
