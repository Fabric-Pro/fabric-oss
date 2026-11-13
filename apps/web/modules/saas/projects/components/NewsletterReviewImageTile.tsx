"use client";

import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import { Label } from "@ui/components/label";
import { cn } from "@ui/lib";
import { ImageIcon, Loader2Icon } from "lucide-react";
import { useId } from "react";
import type { PendingNewsletterImage } from "./newsletter-review-content";

/**
 * One image under a highlight in the review dialog. It asks one question,
 * "Include in email"; everything rarer lives behind the image itself and
 * "Change", which both open the image dialog. A screenshot being captured
 * shows that instead, with "Include in email" unticked until it lands, and one
 * that could not be captured says why in one line.
 */
export function NewsletterReviewImageTile({
	image,
	disabled,
	onOpen,
	onIncludedChange,
	onImageError,
}: {
	image: PendingNewsletterImage;
	disabled: boolean;
	onOpen: () => void;
	onIncludedChange: (included: boolean) => void;
	onImageError: () => void;
}) {
	const includeId = useId();
	const alt = image.altText?.trim() ?? "";
	const capturing = image.captureState === "CAPTURING";
	const failed = image.captureState === "FAILED";
	const reason = image.errorMessage?.trim() ?? "";

	return (
		<div className="flex w-[260px] max-w-full flex-col gap-1.5">
			<button
				type="button"
				onClick={onOpen}
				aria-label={
					failed
						? "Open screenshot that was not captured"
						: `Open image: ${alt || "no description"}`
				}
				className={cn(
					"relative block aspect-[600/340] w-full overflow-hidden rounded-md border bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
					image.included && !failed && !capturing
						? "border-primary ring-1 ring-primary"
						: "border-border",
					failed && "border-dashed",
				)}
			>
				{image.url ? (
					<img
						src={image.url}
						alt=""
						onError={onImageError}
						className={cn(
							"size-full object-cover object-top transition-opacity",
							image.included && !capturing
								? "opacity-100"
								: "opacity-50",
						)}
					/>
				) : (
					<span className="flex size-full items-center justify-center text-muted-foreground">
						<ImageIcon className="size-5" aria-hidden="true" />
					</span>
				)}
				{capturing ? (
					<span
						role="status"
						className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-foreground text-sm"
					>
						<Loader2Icon
							className="size-4 motion-safe:animate-spin"
							aria-hidden="true"
						/>
						{image.url
							? "Capturing again…"
							: "Capturing screenshot…"}
					</span>
				) : null}
			</button>
			{failed ? (
				<div className="flex items-center justify-between gap-2">
					<p
						className="min-w-0 truncate text-muted-foreground text-sm"
						title={reason || undefined}
					>
						{reason || "The screenshot could not be captured."}
					</p>
					<Button
						type="button"
						size="sm"
						variant="ghost"
						onClick={onOpen}
					>
						Change
					</Button>
				</div>
			) : (
				<>
					<div className="flex items-center justify-between gap-2">
						<div className="flex items-center gap-2">
							<Checkbox
								id={includeId}
								checked={image.included && !capturing}
								disabled={disabled || capturing}
								onCheckedChange={(checked) =>
									onIncludedChange(checked === true)
								}
							/>
							<Label
								htmlFor={includeId}
								className="font-normal text-sm"
							>
								Include in email
							</Label>
						</div>
						<Button
							type="button"
							size="sm"
							variant="ghost"
							onClick={onOpen}
						>
							Change
						</Button>
					</div>
					{reason && !capturing ? (
						<p
							className="truncate text-muted-foreground text-xs"
							title={reason}
						>
							Not captured again: {reason}
						</p>
					) : null}
				</>
			)}
		</div>
	);
}
