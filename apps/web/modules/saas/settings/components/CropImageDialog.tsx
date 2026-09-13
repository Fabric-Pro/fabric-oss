"use client";

import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { useMemo, useRef, useState } from "react";
import type { ReactCropperElement } from "react-cropper";
import Cropper from "react-cropper";

/**
 * Crop an uploaded image to a square before it is stored.
 *
 * The cropper is boxed to a fixed height so the dialog never grows past the
 * viewport: a tall source image used to push the footer below the fold with
 * nothing to say it was there, and the only visible control was the close
 * cross. The title and the two buttons are always on screen.
 */
export function CropImageDialog({
	image,
	open,
	onOpenChange,
	onCrop,
	title = "Crop the image",
	description = "Drag to reposition and pull the corners to resize. The selected square is what will be saved.",
}: {
	image: File | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onCrop: (croppedImage: Blob | null) => void;
	title?: string;
	description?: string;
}) {
	const cropperRef = useRef<ReactCropperElement>(null);
	const [saving, setSaving] = useState(false);

	const getCroppedImage = async () => {
		const cropper = cropperRef.current?.cropper;

		const imageBlob = await new Promise<Blob | null>((resolve) => {
			cropper
				?.getCroppedCanvas({
					maxWidth: 256,
					maxHeight: 256,
				})
				.toBlob(resolve);
		});

		return imageBlob;
	};

	const imageSrc = useMemo(
		() => image && URL.createObjectURL(image),
		[image],
	);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-lg gap-5">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>
				<div className="overflow-hidden rounded-lg border border-border/60 bg-muted/40">
					{imageSrc && (
						<Cropper
							src={imageSrc}
							style={{ width: "100%", height: 360 }}
							initialAspectRatio={1}
							aspectRatio={1}
							viewMode={1}
							autoCropArea={1}
							guides={true}
							responsive={true}
							ref={cropperRef}
						/>
					)}
				</div>
				<DialogFooter className="gap-2 sm:gap-2">
					<Button
						type="button"
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={saving}
					>
						Cancel
					</Button>
					<Button
						type="button"
						disabled={saving}
						onClick={async () => {
							setSaving(true);
							try {
								onCrop(await getCroppedImage());
								onOpenChange(false);
							} finally {
								setSaving(false);
							}
						}}
					>
						Save
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
