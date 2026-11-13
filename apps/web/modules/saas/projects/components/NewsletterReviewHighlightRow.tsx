"use client";

import { DragOverlay } from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Checkbox } from "@ui/components/checkbox";
import { cn } from "@ui/lib";
import {
	CameraIcon,
	GripVerticalIcon,
	Loader2Icon,
	PlusIcon,
} from "lucide-react";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { NEWSLETTER_IMAGE_ACCEPT } from "../lib/newsletter-review-images";
import { NewsletterCapturePrompt } from "./NewsletterCapturePrompt";
import { ExcludedPill } from "./NewsletterReviewHighlight";
import { NewsletterReviewImageTile } from "./NewsletterReviewImageTile";
import type {
	PendingNewsletterImage,
	ReviewHighlight,
} from "./newsletter-review-content";

/**
 * What follows the pointer or the arrow keys while a highlight is dragged:
 * its title on a card. It floats above the list, so when an arrow key
 * scrolls the list to bring the next highlight into view, that highlight
 * moves under the card and becomes the drop target. A dragged row inside the
 * list would scroll along with it and stay where it was.
 */
export function NewsletterReviewDragPreview({
	title,
}: {
	/** The dragged highlight's title, or undefined when none is dragged. */
	title: string | undefined;
}) {
	return createPortal(
		<DragOverlay dropAnimation={null}>
			{title === undefined ? null : (
				<div
					aria-hidden="true"
					className="flex items-center gap-2 rounded-lg border border-border bg-card p-3.5 text-foreground text-sm shadow-elevated"
				>
					<GripVerticalIcon
						className="-ml-1 size-4 shrink-0 text-muted-foreground"
						aria-hidden="true"
					/>
					<strong className="truncate">{title}</strong>
				</div>
			)}
		</DragOverlay>,
		document.body,
	);
}

/**
 * One highlight in the review dialog: a reorder grip, the same include
 * checkbox and "Excluded" pill as the inline checklist, and — while it is
 * included — its images with a way to add one: upload a file, or, when the
 * send has an environment to capture from, describe the screen to capture.
 *
 * The grip is a real `<button>` (see `SortableCaseRow`): dnd-kit's keyboard
 * sensor reorders through the focused activator.
 */
export function NewsletterReviewHighlightRow({
	sortableId,
	highlightIndex,
	reorderable,
	highlight,
	excluded,
	images,
	canAddImage,
	canCapture,
	uploading,
	imagesDisabled,
	onToggle,
	onAddImage,
	onCaptureImage,
	onOpenImage,
	onImageIncludedChange,
	onImageError,
}: {
	sortableId: string;
	/** Its index in `content.highlights`; marks the row's focus targets. */
	highlightIndex: number;
	/** False when it is alone in its release: nothing to reorder against. */
	reorderable: boolean;
	highlight: ReviewHighlight;
	excluded: boolean;
	images: PendingNewsletterImage[];
	/** Room for another image under this highlight. */
	canAddImage: boolean;
	/** The send has an environment to capture screenshots from. */
	canCapture: boolean;
	/** An upload for this highlight is running. */
	uploading: boolean;
	imagesDisabled: boolean;
	onToggle: () => void;
	onAddImage: (file: File) => void;
	onCaptureImage: (prompt: string) => void;
	onOpenImage: (imageId: string) => void;
	onImageIncludedChange: (imageId: string, included: boolean) => void;
	onImageError: () => void;
}) {
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: sortableId, disabled: !reorderable });
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [describing, setDescribing] = useState(false);

	return (
		<li
			ref={setNodeRef}
			style={{ transform: CSS.Transform.toString(transform), transition }}
			className={cn(
				"rounded-lg border border-border",
				excluded ? "bg-muted" : "bg-card",
				isDragging && "opacity-40",
			)}
		>
			<div className="flex items-start gap-2 p-3.5">
				{reorderable ? (
					<button
						type="button"
						aria-label={`Reorder ${highlight.title}`}
						className="-ml-1 shrink-0 cursor-grab rounded p-0.5 text-muted-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring active:cursor-grabbing"
						{...attributes}
						{...listeners}
					>
						<GripVerticalIcon
							className="size-4"
							aria-hidden="true"
						/>
					</button>
				) : (
					<span
						aria-hidden="true"
						className="-ml-1 size-5 shrink-0"
					/>
				)}
				<Checkbox
					checked={!excluded}
					onCheckedChange={onToggle}
					aria-label={`Include ${highlight.title}`}
					className="mt-0.5"
					data-review-include={highlightIndex}
				/>
				<div className="min-w-0 flex-1 text-sm">
					<p
						className={
							excluded
								? "text-muted-foreground"
								: "text-foreground"
						}
					>
						<strong>{highlight.title}</strong>
						{excluded ? <ExcludedPill /> : null}
					</p>
					<p className="mt-0.5 text-muted-foreground">
						{highlight.description}
					</p>
				</div>
			</div>
			{excluded ? null : (
				<div className="flex flex-wrap items-start gap-3 px-3.5 pb-3.5 sm:pl-[3.75rem]">
					{images.map((image) => (
						<NewsletterReviewImageTile
							key={image.id}
							image={image}
							disabled={imagesDisabled}
							onOpen={() => onOpenImage(image.id)}
							onIncludedChange={(included) =>
								onImageIncludedChange(image.id, included)
							}
							onImageError={onImageError}
						/>
					))}
					{uploading ? (
						<div
							role="status"
							className="flex aspect-[600/340] w-[260px] max-w-full flex-col items-center justify-center gap-2 rounded-md border border-border border-dashed text-muted-foreground text-sm"
						>
							<Loader2Icon
								className="size-4 motion-safe:animate-spin"
								aria-hidden="true"
							/>
							Uploading…
						</div>
					) : canAddImage ? (
						<>
							<button
								type="button"
								disabled={imagesDisabled}
								data-review-add-image={highlightIndex}
								onClick={() => fileInputRef.current?.click()}
								className="flex items-center justify-center gap-2 rounded-md border border-border border-dashed px-3 py-2 text-muted-foreground text-sm transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
							>
								<PlusIcon
									className="size-4"
									aria-hidden="true"
								/>
								Add image
							</button>
							<input
								ref={fileInputRef}
								type="file"
								accept={NEWSLETTER_IMAGE_ACCEPT}
								className="hidden"
								tabIndex={-1}
								aria-hidden="true"
								onChange={(event) => {
									const file = event.target.files?.[0];
									event.target.value = "";
									if (file) {
										onAddImage(file);
									}
								}}
							/>
							{canCapture && !describing ? (
								<button
									type="button"
									disabled={imagesDisabled}
									onClick={() => setDescribing(true)}
									className="flex items-center justify-center gap-2 rounded-md border border-border border-dashed px-3 py-2 text-muted-foreground text-sm transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
								>
									<CameraIcon
										className="size-4"
										aria-hidden="true"
									/>
									Capture screenshot
								</button>
							) : null}
						</>
					) : null}
					{canCapture && canAddImage && describing ? (
						<NewsletterCapturePrompt
							label={`What should the screenshot for ${highlight.title} show?`}
							submitLabel="Capture"
							initial=""
							required
							disabled={imagesDisabled}
							onSubmit={(prompt) => {
								setDescribing(false);
								onCaptureImage(prompt);
							}}
							onCancel={() => setDescribing(false)}
						/>
					) : null}
				</div>
			)}
		</li>
	);
}
