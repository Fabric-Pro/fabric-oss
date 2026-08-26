"use client";

import {
	humanFileSize,
	TEXT_ATTACHMENT_ACCEPT_ATTR,
} from "@repo/utils/attachment";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { PaperclipIcon, XIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback } from "react";
import {
	DEFAULT_DOC_ATTACHMENT_DESIGNATION,
	type PendingDocAttachment,
	type StoryAttachmentDesignation,
	validateTextAttachmentFile,
} from "../../lib/text-attachment-validation";
import { AttachmentDropzone } from "./AttachmentDropzone";

export interface CreateStoryDocAttachmentsFieldProps {
	items: PendingDocAttachment[];
	onChange: (next: PendingDocAttachment[]) => void;
	onValidationError?: (message: string) => void;
	disabled?: boolean;
}

/**
 * Create-flow section for attaching .docx/.md/.txt reference documents and
 * .excalidraw diagrams (#1942) to a feature. Files are buffered client-side
 * (the attachment API needs a saved feature id); the parent uploads them after
 * the feature is created — that upload path re-validates Excalidraw content and
 * the server stays authoritative. Each file carries a designation — Context
 * only (default) or Asset (protected).
 */
export function CreateStoryDocAttachmentsField({
	items,
	onChange,
	onValidationError,
	disabled,
}: CreateStoryDocAttachmentsFieldProps) {
	const t = useTranslations("projects.stories.create.docAttachments");

	const acceptFiles = useCallback(
		(picked: File[]) => {
			const accepted: PendingDocAttachment[] = [];
			for (const file of picked) {
				const v = validateTextAttachmentFile(file);
				if (!v.valid) {
					onValidationError?.(
						v.errorCode === "too-large"
							? t("validationToast.tooLarge")
							: t("validationToast.unsupportedType"),
					);
					continue;
				}
				accepted.push({
					file,
					designation: DEFAULT_DOC_ATTACHMENT_DESIGNATION,
				});
			}
			if (accepted.length > 0) {
				onChange([...items, ...accepted]);
			}
		},
		[items, onChange, onValidationError, t],
	);

	const setDesignation = (
		index: number,
		designation: StoryAttachmentDesignation,
	) => {
		onChange(
			items.map((it, i) => (i === index ? { ...it, designation } : it)),
		);
	};

	const remove = (index: number) => {
		const next = [...items];
		next.splice(index, 1);
		onChange(next);
	};

	return (
		<div className="space-y-2">
			<AttachmentDropzone
				testId="doc-attachments-field"
				accept={TEXT_ATTACHMENT_ACCEPT_ATTR}
				ariaLabel={t("dropzoneAriaLabel")}
				dropHint={t("dropHint")}
				attachButton={t("attachButton")}
				limitsCaption={t("limitsCaption")}
				disabled={disabled}
				onFiles={acceptFiles}
			/>

			{items.length > 0 && (
				<ul className="space-y-2">
					{items.map((it, i) => (
						<li
							key={`${it.file.name}-${i}-${it.file.size}`}
							className="flex items-center gap-2 text-sm"
						>
							<PaperclipIcon
								className="size-4 shrink-0 text-muted-foreground"
								aria-hidden
							/>
							<span className="min-w-0 flex-1 truncate">
								{it.file.name}
							</span>
							<span className="shrink-0 text-muted-foreground text-xs">
								{humanFileSize(it.file.size)}
							</span>
							<Select
								value={it.designation}
								onValueChange={(v) =>
									setDesignation(
										i,
										v as StoryAttachmentDesignation,
									)
								}
								disabled={disabled}
							>
								<SelectTrigger
									className="h-7 w-[9.5rem] shrink-0 text-xs"
									aria-label={t("designationAriaLabel", {
										name: it.file.name,
									})}
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="UNLOCKED">
										{t("designationContextOnly")}
									</SelectItem>
									<SelectItem value="LOCKED">
										{t("designationAsset")}
									</SelectItem>
								</SelectContent>
							</Select>
							<button
								type="button"
								disabled={disabled}
								onClick={() => remove(i)}
								aria-label={t("removeAriaLabel", {
									name: it.file.name,
								})}
								className="shrink-0 text-muted-foreground hover:text-destructive"
							>
								<XIcon className="size-4" />
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
