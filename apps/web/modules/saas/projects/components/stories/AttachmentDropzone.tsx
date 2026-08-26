"use client";

import { Button } from "@ui/components/button";
import { useRef } from "react";

export interface AttachmentDropzoneProps {
	/** Prefix for the `-dropzone` / `-input` test ids (e.g. "attachments-field"). */
	testId: string;
	/** `accept` attribute for the file input. */
	accept: string;
	ariaLabel: string;
	dropHint: string;
	attachButton: string;
	limitsCaption: string;
	disabled?: boolean;
	/** Called with the picked/dropped files; the caller owns validation + state. */
	onFiles: (files: File[]) => void;
}

/**
 * Presentational drop zone shared by the create-flow attachment pickers
 * (`AttachmentsField` for images, `CreateStoryDocAttachmentsField` for docs).
 * Callers pass resolved i18n strings and an `onFiles` handler; validation and
 * the file list below live in each caller.
 */
export function AttachmentDropzone({
	testId,
	accept,
	ariaLabel,
	dropHint,
	attachButton,
	limitsCaption,
	disabled,
	onFiles,
}: AttachmentDropzoneProps) {
	const inputRef = useRef<HTMLInputElement>(null);

	return (
		<div
			data-testid={`${testId}-dropzone`}
			role="button"
			tabIndex={disabled ? -1 : 0}
			aria-label={ariaLabel}
			onDragOver={(e) => e.preventDefault()}
			onDrop={(e) => {
				e.preventDefault();
				if (disabled) {
					return;
				}
				onFiles(Array.from(e.dataTransfer.files));
			}}
			onKeyDown={(e) => {
				if (disabled) {
					return;
				}
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					inputRef.current?.click();
				}
			}}
			className="rounded-md border border-dashed border-border bg-muted/30 p-4 text-center focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
		>
			<p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
				{dropHint}
			</p>
			<Button
				type="button"
				variant="ghost"
				size="sm"
				disabled={disabled}
				onClick={() => inputRef.current?.click()}
				className="mt-1"
			>
				{attachButton}
			</Button>
			<p className="text-xs text-muted-foreground">{limitsCaption}</p>
			{/*
			 * `sr-only` (off-screen but rendered), NOT `hidden` (display:none) —
			 * Chromium 124+ blocks the OS file picker for programmatic `.click()`
			 * on display:none inputs. Same pattern as WizardFileUploader.
			 */}
			<input
				ref={inputRef}
				data-testid={`${testId}-input`}
				type="file"
				accept={accept}
				multiple
				className="sr-only"
				aria-hidden="true"
				tabIndex={-1}
				onChange={(e) => {
					onFiles(Array.from(e.target.files ?? []));
					e.target.value = "";
				}}
			/>
		</div>
	);
}
