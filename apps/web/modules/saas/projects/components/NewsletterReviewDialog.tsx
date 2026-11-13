"use client";

import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	KeyboardSensor,
	PointerSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	SortableContext,
	sortableKeyboardCoordinates,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { NEWSLETTER_IMAGES_PER_HIGHLIGHT_MAX } from "@repo/database/src/newsletter-schema";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { useRef, useState } from "react";
import { reviewDragAnnouncements } from "../lib/newsletter-review-announcements";
import { reviewFocusFallback } from "../lib/newsletter-review-focus";
import {
	groupReviewHighlights,
	moveWithinGroup,
	type ReviewHighlightGroup,
} from "../lib/newsletter-review-groups";
import {
	approveButtonLabel,
	imagesByHighlight,
	includedImagesLine,
	summarizeReviewImages,
} from "../lib/newsletter-review-images";
import {
	NewsletterReviewDragPreview,
	NewsletterReviewHighlightRow,
} from "./NewsletterReviewHighlightRow";
import { NewsletterReviewImageDialog } from "./NewsletterReviewImageDialog";
import {
	type PendingNewsletterSend,
	readReviewContent,
} from "./newsletter-review-content";
import { useNewsletterReviewImages } from "./use-newsletter-review-images";

interface ReviewDecisionProps {
	projectId: string;
	organizationId: string | null;
	/** Highlight indexes the reviewer left out. */
	removed: ReadonlySet<number>;
	/** The reviewer's order, as indexes into `content.highlights`. */
	order: number[];
	reviewInFlight: boolean;
	onToggle: (index: number) => void;
	onOrderChange: (order: number[]) => void;
	onApprove: () => void;
	onReject: () => void;
	onRefetch: () => void;
	onOpenChange: (open: boolean) => void;
}

/**
 * The review of a held send that takes images. One narrow column that reads
 * like the email: highlights grouped by release exactly as the email groups
 * them, in the reviewer's order within each release, each with its images.
 * The header and footer stay put while the list scrolls.
 */
export function NewsletterReviewDialog({
	send,
	...props
}: ReviewDecisionProps & { send: PendingNewsletterSend | null }) {
	// Escape during a keyboard reorder belongs to dnd-kit, which cancels the
	// drag. The dialog's own Escape listener runs first (capture phase), so it
	// must stand down while a drag is active or it closes the whole review.
	const dragActive = useRef(false);
	return (
		<Dialog open={send !== null} onOpenChange={props.onOpenChange}>
			<DialogContent
				className="flex max-h-[90vh] max-w-3xl flex-col gap-0 overflow-hidden p-0"
				onEscapeKeyDown={(event) => {
					if (dragActive.current) {
						event.preventDefault();
					}
				}}
			>
				{send ? (
					<ReviewBody
						send={send}
						{...props}
						onDragActiveChange={(active) => {
							dragActive.current = active;
						}}
					/>
				) : null}
			</DialogContent>
		</Dialog>
	);
}

/** What opened the image dialog, so focus can land nearby if it is gone. */
interface ImageDialogOrigin {
	trigger: HTMLElement | null;
	highlightIndex: number;
}

function sortableIdOf(index: number): string {
	return `highlight-${index}`;
}

function ReviewBody({
	send,
	projectId,
	organizationId,
	removed,
	order,
	reviewInFlight,
	onToggle,
	onOrderChange,
	onApprove,
	onReject,
	onRefetch,
	onOpenChange,
	onDragActiveChange,
}: ReviewDecisionProps & {
	send: PendingNewsletterSend;
	onDragActiveChange: (active: boolean) => void;
}) {
	const content = readReviewContent(send.content);
	const highlights = content?.highlights ?? [];
	const [openImageId, setOpenImageId] = useState<string | null>(null);
	const [draggedId, setDraggedId] = useState<string | null>(null);
	// A signed URL lives ~15 minutes. The first image that fails to load
	// refetches the list once (fresh URLs); a second failure is left alone.
	const refetchedForImageError = useRef(false);
	const onImageError = () => {
		if (!refetchedForImageError.current) {
			refetchedForImageError.current = true;
			onRefetch();
		}
	};

	const images = useNewsletterReviewImages({
		projectId,
		organizationId,
		sendId: send.id,
		onChanged: onRefetch,
		onConflict: () => {
			onRefetch();
			onOpenChange(false);
		},
	});

	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
		useSensor(KeyboardSensor, {
			coordinateGetter: sortableKeyboardCoordinates,
		}),
	);
	// The email's grouping, over the reviewer's order: what is shown here is
	// the order that goes out.
	const groups = groupReviewHighlights(highlights, order);
	const displayed = groups.flatMap((group) => group.indexes);
	const anyReorderable = groups.some((group) => group.indexes.length > 1);
	const multiRepo =
		new Set(groups.map((g) => g.repoFullName).filter(Boolean)).size > 1;
	const groupHeading = (group: ReviewHighlightGroup) =>
		group.tag ?? (groups.length > 1 ? "Other changes" : null);

	const indexBySortableId = new Map(
		displayed.map((index): [string, number] => [
			sortableIdOf(index),
			index,
		]),
	);
	const announcements = reviewDragAnnouncements((sortableId) => {
		const index = indexBySortableId.get(sortableId);
		return index === undefined ? undefined : highlights[index]?.title;
	});
	const draggedIndex =
		draggedId === null ? undefined : indexBySortableId.get(draggedId);
	const handleDragEnd = ({ active, over }: DragEndEvent) => {
		setDraggedId(null);
		onDragActiveChange(false);
		const from = indexBySortableId.get(String(active.id));
		const to = over ? indexBySortableId.get(String(over.id)) : undefined;
		const group = groups.find(
			(g) => from !== undefined && g.indexes.includes(from),
		);
		if (from === undefined || to === undefined || !group) {
			return;
		}
		const next = moveWithinGroup(order, group.indexes, from, to);
		if (next.some((index, i) => index !== order[i])) {
			onOrderChange(next);
		}
	};

	const byHighlight = imagesByHighlight(send.images);
	const summary = summarizeReviewImages(send.images, removed);
	const summaryLine = includedImagesLine(summary);
	const openImage = send.images.find((i) => i.id === openImageId) ?? null;
	const withOpenImage = (act: (imageId: string) => void) => {
		if (openImage) {
			act(openImage.id);
		}
	};
	const highlightOptions = displayed
		.filter((i) => !removed.has(i))
		.map((i) => ({
			index: i,
			title: highlights[i].title,
			full:
				(byHighlight.get(i)?.length ?? 0) >=
				NEWSLETTER_IMAGES_PER_HIGHLIGHT_MAX,
		}));
	const decisionDisabled = reviewInFlight || images.uploading;
	// Approving now would send without a screenshot still on its way.
	const capturing = send.images.some((i) => i.captureState === "CAPTURING");
	// "Include all" ticks every finished picture under a kept highlight.
	const anyToInclude = send.images.some(
		(i) =>
			i.captureState === "READY" &&
			!i.included &&
			!removed.has(i.highlightIndex),
	);
	const includeAll = () => images.includeAllImages([...removed]);
	const canCapture = Boolean(send.screenshotEnvironmentId);
	const openSiblingCount = openImage
		? (byHighlight.get(openImage.highlightIndex)?.length ?? 0)
		: 0;
	const uploadingIndex =
		images.uploadingTarget?.kind === "add"
			? images.uploadingTarget.highlightIndex
			: null;

	// The image dialog returns focus to the tile it was opened from. After a
	// Remove or a Move that tile is gone, so focus goes to the same
	// highlight's "Add image" button, or else its include checkbox.
	const listRef = useRef<HTMLDivElement>(null);
	const openedFrom = useRef<ImageDialogOrigin | null>(null);
	const openImageFrom = (imageId: string) => {
		const image = send.images.find((i) => i.id === imageId);
		const active = document.activeElement;
		openedFrom.current = image
			? {
					trigger: active instanceof HTMLElement ? active : null,
					highlightIndex: image.highlightIndex,
				}
			: null;
		setOpenImageId(imageId);
	};
	const handleImageDialogCloseAutoFocus = (event: Event) => {
		const origin = openedFrom.current;
		if (!origin?.trigger || origin.trigger.isConnected) {
			return;
		}
		const target = reviewFocusFallback(
			listRef.current,
			origin.highlightIndex,
		);
		if (target) {
			event.preventDefault();
			target.focus();
		}
	};

	const renderRow = (index: number, reorderable: boolean) => {
		const highlightImages = byHighlight.get(index) ?? [];
		return (
			<NewsletterReviewHighlightRow
				key={sortableIdOf(index)}
				sortableId={sortableIdOf(index)}
				highlightIndex={index}
				reorderable={reorderable}
				highlight={highlights[index]}
				excluded={removed.has(index)}
				images={highlightImages}
				canAddImage={
					highlightImages.length < NEWSLETTER_IMAGES_PER_HIGHLIGHT_MAX
				}
				canCapture={canCapture}
				uploading={uploadingIndex === index}
				imagesDisabled={reviewInFlight || images.busy}
				onToggle={() => onToggle(index)}
				onAddImage={(file) =>
					images.uploadImage(file, {
						kind: "add",
						highlightIndex: index,
					})
				}
				onCaptureImage={(prompt) => images.captureImage(index, prompt)}
				onOpenImage={openImageFrom}
				onImageIncludedChange={(imageId, included) =>
					images.updateImage(imageId, { included })
				}
				onImageError={onImageError}
			/>
		);
	};

	return (
		<>
			<DialogHeader className="border-border border-b px-6 pt-6 pb-4">
				<div className="flex items-center gap-2">
					<span
						aria-hidden="true"
						className="h-3 w-[3px] shrink-0 bg-primary"
					/>
					<span className="font-medium text-[11px] text-muted-foreground uppercase tracking-[0.2em]">
						Review newsletter
					</span>
				</div>
				<DialogTitle className="text-xl">
					{content?.headline ?? "Release notes"}
				</DialogTitle>
				<DialogDescription>
					{anyReorderable
						? "Tick what should go out. Drag to change the order within a release."
						: "Tick what should go out."}
				</DialogDescription>
			</DialogHeader>

			<div
				ref={listRef}
				className="min-h-0 flex-1 overflow-y-auto px-6 py-4"
			>
				<div className="mx-auto max-w-[640px] space-y-4">
					{content?.intro ? (
						<p className="text-foreground text-sm leading-relaxed">
							{content.intro}
						</p>
					) : null}
					{groups.map((group) => {
						const heading = groupHeading(group);
						return (
							<section key={group.key} className="space-y-2.5">
								{heading ? (
									<div className="flex items-center gap-3">
										<span className="rounded-full bg-muted px-2 py-1 font-semibold text-primary text-xs">
											{heading}
										</span>
										{multiRepo && group.repoFullName ? (
											<span className="text-muted-foreground text-xs">
												{group.repoFullName
													.split("/")
													.pop()}
											</span>
										) : null}
										<div className="h-px flex-1 bg-border" />
									</div>
								) : null}
								{/* One drag context per release: a highlight can only
								    land among its own release's highlights. */}
								<DndContext
									sensors={sensors}
									collisionDetection={closestCenter}
									accessibility={{ announcements }}
									onDragStart={({ active }) => {
										setDraggedId(String(active.id));
										onDragActiveChange(true);
									}}
									onDragEnd={handleDragEnd}
									onDragCancel={() => {
										setDraggedId(null);
										onDragActiveChange(false);
									}}
								>
									<SortableContext
										items={group.indexes.map(sortableIdOf)}
										strategy={verticalListSortingStrategy}
									>
										<ul className="space-y-2.5">
											{group.indexes.map((index) =>
												renderRow(
													index,
													group.indexes.length > 1,
												),
											)}
										</ul>
									</SortableContext>
									<NewsletterReviewDragPreview
										title={
											draggedIndex !== undefined &&
											group.indexes.includes(draggedIndex)
												? highlights[draggedIndex]
														?.title
												: undefined
										}
									/>
								</DndContext>
							</section>
						);
					})}
				</div>
			</div>

			<div className="flex flex-wrap items-center justify-between gap-3 border-border border-t px-6 py-4">
				<p className="text-muted-foreground text-sm" role="status">
					{capturing
						? "Wait for the screenshots that are still being captured."
						: summaryLine}
				</p>
				<div className="flex flex-wrap gap-2">
					{send.images.length > 0 ? (
						<Button
							type="button"
							variant="ghost"
							aria-label="Include all images"
							disabled={
								!anyToInclude || reviewInFlight || images.busy
							}
							onClick={includeAll}
						>
							Include all
						</Button>
					) : null}
					<Button
						type="button"
						variant="outline"
						disabled={decisionDisabled}
						onClick={onReject}
					>
						Reject
					</Button>
					<Button
						type="button"
						variant="primary"
						disabled={decisionDisabled || capturing}
						onClick={onApprove}
					>
						{approveButtonLabel(summary.included)}
					</Button>
				</div>
			</div>

			<NewsletterReviewImageDialog
				image={openImage}
				highlightOptions={highlightOptions}
				siblingCount={openSiblingCount}
				canCapture={canCapture}
				disabled={reviewInFlight || images.busy}
				onOpenChange={(open) => {
					if (!open) {
						setOpenImageId(null);
					}
				}}
				onIncludedChange={(included) =>
					withOpenImage((id) => images.updateImage(id, { included }))
				}
				onAltTextCommit={(altText) =>
					withOpenImage((id) => images.updateImage(id, { altText }))
				}
				onPlacementChange={(placement) =>
					withOpenImage((id) => images.updateImage(id, { placement }))
				}
				onMove={(highlightIndex) =>
					withOpenImage((id) =>
						images.updateImage(id, { highlightIndex }),
					)
				}
				onReorder={(position) =>
					withOpenImage((id) => images.updateImage(id, { position }))
				}
				onRecapture={(prompt) =>
					withOpenImage((id) => images.recaptureImage(id, prompt))
				}
				onReplace={(file) =>
					withOpenImage((id) =>
						images.uploadImage(file, {
							kind: "replace",
							imageId: id,
						}),
					)
				}
				onRemove={() => withOpenImage(images.removeImage)}
				onImageError={onImageError}
				onCloseAutoFocus={handleImageDialogCloseAutoFocus}
			/>
		</>
	);
}
