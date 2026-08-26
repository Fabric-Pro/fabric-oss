"use client";

import { XIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	compressImageToBudget,
	validateImageFile,
} from "../../lib/image-upload-utils";
import { AttachmentDropzone } from "./AttachmentDropzone";

const SUPPORTED_IMAGE_MIMES = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // matches validateImageFile

export interface AttachmentsFieldProps {
	files: File[];
	onChange: (next: File[]) => void;
	onValidationError?: (message: string) => void;
	disabled?: boolean;
}

function Thumb({
	file,
	onRemove,
	disabled,
}: {
	file: File;
	onRemove: () => void;
	disabled?: boolean;
}) {
	const t = useTranslations("projects.stories.create.attachments");
	const url = useMemo(() => URL.createObjectURL(file), [file]);
	useEffect(() => () => URL.revokeObjectURL(url), [url]);

	return (
		<div className="relative size-20 overflow-hidden rounded-md border border-border bg-muted">
			<img src={url} alt={file.name} className="size-full object-cover" />
			<button
				type="button"
				disabled={disabled}
				onClick={onRemove}
				aria-label={t("removeAriaLabel", { name: file.name })}
				className="absolute right-1 top-1 grid size-5 place-items-center rounded-full bg-background/90 text-foreground shadow-sm hover:bg-background"
			>
				<XIcon className="size-3" />
			</button>
		</div>
	);
}

export function AttachmentsField({
	files,
	onChange,
	onValidationError,
	disabled,
}: AttachmentsFieldProps) {
	const t = useTranslations("projects.stories.create.attachments");
	const [compressing, setCompressing] = useState(false);

	// Accepting a file is asynchronous now (images are shrunk to the provider's
	// budget first), so two drops can overlap. Both would close over the same
	// `files` prop and the slower one would call `onChange` with a snapshot
	// taken before the faster one landed, silently erasing an attachment the
	// user already saw appear. The ref is claimed synchronously at the moment we
	// hand a new array to `onChange`, so a later-resolving accept appends to the
	// real current set rather than to whatever it captured on its own render.
	const latestFilesRef = useRef(files);
	useEffect(() => {
		// Keep in step with changes the parent makes on its own (a removal).
		latestFilesRef.current = files;
	}, [files]);

	const acceptFiles = useCallback(
		async (picked: File[]) => {
			const accepted: File[] = [];
			for (const f of picked) {
				const v = validateImageFile(f);
				if (!v.valid) {
					if (!onValidationError) {
						continue;
					}
					// Localize based on the failure mode. We re-check the same
					// conditions validateImageFile uses so the i18n keys are
					// wired correctly (it returns English strings).
					if (!SUPPORTED_IMAGE_MIMES.has(f.type)) {
						onValidationError(t("validationToast.unsupportedType"));
					} else if (f.size > MAX_IMAGE_BYTES) {
						onValidationError(t("validationToast.tooLarge"));
					} else if (v.error) {
						onValidationError(v.error);
					}
					continue;
				}

				// Shrink to the provider's ENCODED-size budget before accepting.
				// Passing the raw file through only looks fine: base64 adds a
				// third, so an image inside the 5 MB upload cap can still be
				// refused by the model — and that refusal surfaces much later,
				// as a failed AI request with no actionable message.
				setCompressing(true);
				let shaped: File;
				let withinBudget: boolean;
				try {
					({ file: shaped, withinBudget } =
						await compressImageToBudget(f));
				} finally {
					setCompressing(false);
				}
				if (!withinBudget) {
					// An animated GIF is never re-encoded — that would drop the
					// animation — so it gets its own message rather than one
					// claiming a compression attempt that never happened.
					onValidationError?.(
						f.type === "image/gif"
							? t("validationToast.gifTooLargeForAi")
							: t("validationToast.tooLargeForAi"),
					);
					continue;
				}
				accepted.push(shaped);
			}
			if (accepted.length > 0) {
				const next = [...latestFilesRef.current, ...accepted];
				// Claim the new set before yielding, so an accept still in
				// flight appends to this rather than to its own stale capture.
				latestFilesRef.current = next;
				onChange(next);
			}
		},
		[onChange, onValidationError, t],
	);

	return (
		<div className="space-y-2">
			<AttachmentDropzone
				testId="attachments-field"
				accept="image/png,image/jpeg,image/gif,image/webp"
				ariaLabel={t("dropzoneAriaLabel")}
				dropHint={t("dropHint")}
				attachButton={t("attachButton")}
				limitsCaption={
					compressing ? t("compressing") : t("limitsCaption")
				}
				// Held closed while an image is being shrunk. Without this the
				// zone looks idle during a multi-second canvas re-encode, and a
				// user who reasonably concludes the drop missed and drops again
				// is exactly the overlap the ref above has to absorb.
				disabled={disabled || compressing}
				onFiles={acceptFiles}
			/>

			{files.length > 0 && (
				<div className="grid grid-cols-[repeat(auto-fill,minmax(5rem,1fr))] gap-2">
					{files.map((f, i) => (
						<Thumb
							key={`${f.name}-${i}-${f.size}`}
							file={f}
							disabled={disabled}
							onRemove={() => {
								const next = [...files];
								next.splice(i, 1);
								onChange(next);
							}}
						/>
					))}
				</div>
			)}
		</div>
	);
}
