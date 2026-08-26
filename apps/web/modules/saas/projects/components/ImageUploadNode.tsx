"use client";

/**
 * ImageUploadNode - Renders an upload progress placeholder in the TipTap editor.
 *
 * This component is rendered by the ImageUploadPlaceholder node extension
 * to show upload status (progress bar, error state, retry action).
 */

import { type NodeViewProps, NodeViewWrapper } from "@tiptap/react";
import { Button } from "@ui/components/button";
import { AlertTriangle, ImageIcon, Loader2, RefreshCw, X } from "lucide-react";

interface ImageUploadNodeProps extends NodeViewProps {
	onRetry?: (uploadId: string) => void;
	onCancel?: (uploadId: string) => void;
}

export function ImageUploadNode({
	node,
	onRetry,
	onCancel,
}: ImageUploadNodeProps) {
	const { uploadId, filename, progress, error } = node.attrs;

	return (
		<NodeViewWrapper
			className="image-upload-placeholder"
			data-drag-handle=""
		>
			<output
				className="my-3 rounded-lg border border-border bg-muted/50 p-4"
				aria-label={
					error
						? `Upload failed: ${filename}`
						: `Uploading ${filename}: ${progress}%`
				}
				aria-live="polite"
			>
				{error ? (
					/* Error state */
					<div className="flex items-center gap-3">
						<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-destructive/10">
							<AlertTriangle
								className="h-5 w-5 text-destructive"
								aria-hidden="true"
							/>
						</div>
						<div className="min-w-0 flex-1">
							<p className="truncate text-sm font-medium text-foreground">
								{filename}
							</p>
							<p className="text-xs text-destructive">{error}</p>
						</div>
						<div className="flex gap-1">
							{onRetry && (
								<Button
									variant="ghost"
									size="sm"
									onClick={() => onRetry(uploadId)}
									aria-label={`Retry upload of ${filename}`}
								>
									<RefreshCw className="h-4 w-4" />
								</Button>
							)}
							{onCancel && (
								<Button
									variant="ghost"
									size="sm"
									onClick={() => onCancel(uploadId)}
									aria-label={`Cancel upload of ${filename}`}
								>
									<X className="h-4 w-4" />
								</Button>
							)}
						</div>
					</div>
				) : (
					/* Progress state */
					<div className="flex items-center gap-3">
						<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
							{progress < 100 ? (
								<Loader2
									className="h-5 w-5 text-primary motion-safe:animate-spin"
									aria-hidden="true"
								/>
							) : (
								<ImageIcon
									className="h-5 w-5 text-primary"
									aria-hidden="true"
								/>
							)}
						</div>
						<div className="min-w-0 flex-1">
							<p className="truncate text-sm font-medium text-foreground">
								{filename}
							</p>
							<div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
								<div
									className="h-full rounded-full bg-primary transition-[width] duration-200 ease-out"
									style={{ width: `${progress}%` }}
									role="progressbar"
									aria-valuenow={progress}
									aria-valuemin={0}
									aria-valuemax={100}
								/>
							</div>
							<p className="mt-1 text-xs text-muted-foreground">
								{progress < 100
									? `Uploading... ${progress}%`
									: "Processing..."}
							</p>
						</div>
						{onCancel && progress < 100 && (
							<Button
								variant="ghost"
								size="sm"
								onClick={() => onCancel(uploadId)}
								aria-label={`Cancel upload of ${filename}`}
							>
								<X className="h-4 w-4" />
							</Button>
						)}
					</div>
				)}
			</output>
		</NodeViewWrapper>
	);
}
