"use client";

import {
	NEWSLETTER_IMAGE_ALT_TEXT_MAX,
	type NewsletterImagePlacement,
} from "@repo/database/src/newsletter-schema";
import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { RadioGroup, RadioGroupItem } from "@ui/components/radio-group";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import {
	ArrowDownIcon,
	ArrowUpIcon,
	DownloadIcon,
	ImageIcon,
	Loader2Icon,
	Trash2Icon,
	UploadIcon,
} from "lucide-react";
import { useId, useRef, useState } from "react";
import { NEWSLETTER_IMAGE_ACCEPT } from "../lib/newsletter-review-images";
import { NewsletterCapturePrompt } from "./NewsletterCapturePrompt";
import type { PendingNewsletterImage } from "./newsletter-review-content";

const PLACEMENT_OPTIONS: ReadonlyArray<{
	value: NewsletterImagePlacement;
	label: string;
}> = [
	{ value: "ABOVE", label: "Show above the text" },
	{ value: "BELOW", label: "Show below the text" },
];

interface ImageHighlightOption {
	index: number;
	title: string;
	/** Already holds the most images a highlight can take. */
	full: boolean;
}

/**
 * Everything rare about one review image: see it large, include it, describe
 * it, show it above or below the highlight's text, move it to another
 * highlight or within its own, capture it again, replace, download or remove
 * it. The "Shown under" select and the
 * earlier/later buttons are how an image moves; there is no image drag.
 */
export function NewsletterReviewImageDialog({
	image,
	highlightOptions,
	siblingCount,
	canCapture,
	disabled,
	onOpenChange,
	onIncludedChange,
	onAltTextCommit,
	onPlacementChange,
	onMove,
	onReorder,
	onRecapture,
	onReplace,
	onRemove,
	onImageError,
	onCloseAutoFocus,
}: {
	image: PendingNewsletterImage | null;
	highlightOptions: ImageHighlightOption[];
	/** How many images its highlight holds, itself included. */
	siblingCount: number;
	/** The send has an environment to capture screenshots from. */
	canCapture: boolean;
	disabled: boolean;
	onOpenChange: (open: boolean) => void;
	onIncludedChange: (included: boolean) => void;
	onAltTextCommit: (altText: string) => void;
	/** Show it above or below the highlight's text in the email. */
	onPlacementChange: (placement: NewsletterImagePlacement) => void;
	onMove: (highlightIndex: number) => void;
	/** Move to another position within its highlight. */
	onReorder: (position: number) => void;
	/** Capture again, with new words or (undefined) the same ones. */
	onRecapture: (prompt: string | undefined) => void;
	onReplace: (file: File) => void;
	onRemove: () => void;
	onImageError: () => void;
	/** Where focus goes on close, when the tile that opened it is gone. */
	onCloseAutoFocus: (event: Event) => void;
}) {
	const includeId = useId();
	const shownUnderId = useId();
	const placementId = useId();
	const replaceInputRef = useRef<HTMLInputElement>(null);
	const capturing = image?.captureState === "CAPTURING";
	const failed = image?.captureState === "FAILED";
	const captured = image !== null && image.source !== "UPLOAD";

	return (
		<Dialog open={image !== null} onOpenChange={onOpenChange}>
			<DialogContent
				className="max-w-3xl"
				onCloseAutoFocus={onCloseAutoFocus}
			>
				<DialogHeader>
					<DialogTitle>Image</DialogTitle>
					<DialogDescription>
						Choose whether it goes out, and how it is described.
					</DialogDescription>
				</DialogHeader>
				{image ? (
					<div key={image.id} className="space-y-5">
						<div className="flex max-h-[60vh] items-center justify-center overflow-hidden rounded-md border border-border bg-muted">
							{image.url ? (
								<img
									src={image.url}
									alt={image.altText ?? ""}
									onError={onImageError}
									className="max-h-[60vh] w-auto max-w-full object-contain"
								/>
							) : (
								<span className="flex h-48 items-center justify-center text-muted-foreground">
									<ImageIcon
										className="size-6"
										aria-hidden="true"
									/>
								</span>
							)}
						</div>

						{capturing ? (
							<p
								role="status"
								className="flex items-center gap-2 text-muted-foreground text-sm"
							>
								<Loader2Icon
									className="size-4 motion-safe:animate-spin"
									aria-hidden="true"
								/>
								Capturing the screenshot. This takes a minute or
								two.
							</p>
						) : image.errorMessage ? (
							<p className="text-muted-foreground text-sm">
								{failed
									? `Not captured: ${image.errorMessage}`
									: `Not captured again: ${image.errorMessage}`}
							</p>
						) : null}

						<div className="flex items-center gap-2">
							<Checkbox
								id={includeId}
								checked={image.included}
								disabled={disabled || capturing || failed}
								onCheckedChange={(checked) =>
									onIncludedChange(checked === true)
								}
							/>
							<Label htmlFor={includeId} className="font-normal">
								Include in email
							</Label>
						</div>

						<ImageDescriptionField
							initial={image.altText ?? ""}
							disabled={disabled}
							onCommit={onAltTextCommit}
						/>

						<RadioGroup
							value={
								image.placement === "ABOVE" ? "ABOVE" : "BELOW"
							}
							disabled={disabled}
							onValueChange={(value) =>
								onPlacementChange(
									value === "ABOVE" ? "ABOVE" : "BELOW",
								)
							}
							aria-label="Where the image is shown"
						>
							{PLACEMENT_OPTIONS.map((option) => (
								<div
									key={option.value}
									className="flex items-center gap-2"
								>
									<RadioGroupItem
										value={option.value}
										id={`${placementId}-${option.value}`}
									/>
									<Label
										htmlFor={`${placementId}-${option.value}`}
										className="font-normal"
									>
										{option.label}
									</Label>
								</div>
							))}
						</RadioGroup>

						<div className="space-y-1.5">
							<Label htmlFor={shownUnderId}>Shown under</Label>
							<Select
								value={String(image.highlightIndex)}
								disabled={disabled}
								onValueChange={(value) => onMove(Number(value))}
							>
								<SelectTrigger id={shownUnderId}>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{highlightOptions.map((option) => {
										const full =
											option.full &&
											option.index !==
												image.highlightIndex;
										return (
											<SelectItem
												key={option.index}
												value={String(option.index)}
												disabled={full}
											>
												{full
													? `${option.title} (full)`
													: option.title}
											</SelectItem>
										);
									})}
								</SelectContent>
							</Select>
						</div>

						{siblingCount > 1 ? (
							<div className="flex flex-wrap gap-2">
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={disabled || image.position === 0}
									onClick={() =>
										onReorder(image.position - 1)
									}
								>
									<ArrowUpIcon aria-hidden="true" />
									Move earlier
								</Button>
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={
										disabled ||
										image.position >= siblingCount - 1
									}
									onClick={() =>
										onReorder(image.position + 1)
									}
								>
									<ArrowDownIcon aria-hidden="true" />
									Move later
								</Button>
							</div>
						) : null}

						{captured && canCapture && !capturing ? (
							<NewsletterCapturePrompt
								label="Not the right screen?"
								submitLabel="Capture again"
								initial={image.prompt ?? ""}
								required={false}
								disabled={disabled}
								onSubmit={(prompt) =>
									onRecapture(
										prompt &&
											prompt !==
												(image.prompt ?? "").trim()
											? prompt
											: undefined,
									)
								}
							/>
						) : null}

						<div className="flex flex-wrap gap-2">
							<Button
								type="button"
								variant="outline"
								size="sm"
								disabled={disabled || capturing}
								onClick={() => replaceInputRef.current?.click()}
							>
								<UploadIcon aria-hidden="true" />
								Replace
							</Button>
							<input
								ref={replaceInputRef}
								type="file"
								accept={NEWSLETTER_IMAGE_ACCEPT}
								className="hidden"
								tabIndex={-1}
								aria-hidden="true"
								onChange={(event) => {
									const file = event.target.files?.[0];
									event.target.value = "";
									if (file) {
										onReplace(file);
									}
								}}
							/>
							{image.downloadUrl ? (
								<Button asChild variant="ghost" size="sm">
									<a href={image.downloadUrl} download>
										<DownloadIcon aria-hidden="true" />
										Download
									</a>
								</Button>
							) : null}
							<Button
								type="button"
								variant="ghost"
								size="sm"
								disabled={disabled}
								onClick={onRemove}
							>
								<Trash2Icon aria-hidden="true" />
								Remove
							</Button>
						</div>
					</div>
				) : null}
			</DialogContent>
		</Dialog>
	);
}

/** Saved on blur, and only when it changed. Reseeds per image via the parent key. */
function ImageDescriptionField({
	initial,
	disabled,
	onCommit,
}: {
	initial: string;
	disabled: boolean;
	onCommit: (altText: string) => void;
}) {
	const id = useId();
	const helpId = useId();
	const [value, setValue] = useState(initial);

	return (
		<div className="space-y-1.5">
			<Label htmlFor={id}>Description</Label>
			<Input
				id={id}
				value={value}
				maxLength={NEWSLETTER_IMAGE_ALT_TEXT_MAX}
				disabled={disabled}
				aria-describedby={helpId}
				onChange={(event) => setValue(event.target.value)}
				onBlur={() => {
					const next = value.trim();
					if (next !== initial.trim()) {
						onCommit(next);
					}
				}}
			/>
			<p id={helpId} className="text-muted-foreground text-xs">
				Shown to readers whose mail app blocks pictures.
			</p>
		</div>
	);
}
