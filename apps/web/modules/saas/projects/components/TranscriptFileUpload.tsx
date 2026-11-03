"use client";

/**
 * Adding meeting transcripts as files (Fizzy #1877), for meetings that never ran
 * through a connected Teams account. Lives in the meeting transcript settings,
 * which the project setup wizard also renders, so it is reachable from both.
 *
 * The rows come from the project's context list rather than from the transcript
 * table, because a file has a context from the moment it is sent and a transcript
 * only once it has been read. A failed file never gets a transcript at all, and
 * it still has to say why.
 */

import {
	formatSizeLimit,
	TRANSCRIPT_UPLOAD_ACCEPT_ATTR,
	TRANSCRIPT_UPLOAD_FORMAT_LIST,
	TRANSCRIPT_UPLOAD_MAX_BYTES,
	UPLOADED_TRANSCRIPT_PROVIDER,
} from "@repo/utils";
import {
	transcriptFileProblem,
	uploadTranscriptFile,
} from "@saas/projects/lib/upload-transcript-file";
import { useConfirmationAlert } from "@saas/shared/components/ConfirmationAlertProvider";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Loader2Icon, Trash2Icon, UploadIcon } from "lucide-react";
import { type ChangeEvent, useId, useRef, useState } from "react";
import { toast } from "sonner";

const POLL_WHILE_PROCESSING_MS = 3_000;

const GUIDANCE = `${TRANSCRIPT_UPLOAD_FORMAT_LIST} — ${formatSizeLimit(TRANSCRIPT_UPLOAD_MAX_BYTES)}`;

interface UploadedTranscriptRow {
	id: string;
	type: string;
	extractionStatus: string;
	extractionError?: string | null;
	originalFilename?: string | null;
	metadata?: unknown;
}

interface UploadedTranscriptMetadata {
	provider?: string;
	meetingSubject?: string;
	unreadableParts?: number;
}

function metadataOf(row: UploadedTranscriptRow): UploadedTranscriptMetadata {
	return (row.metadata ?? {}) as UploadedTranscriptMetadata;
}

function isProcessing(row: UploadedTranscriptRow): boolean {
	return (
		row.extractionStatus === "PENDING" ||
		row.extractionStatus === "EXTRACTING"
	);
}

/**
 * How often to read the list again: while a file is being processed, and while
 * a removed row is still there, since `delete` returns once the deletion has
 * started and a worker takes the row away later.
 */
export function transcriptListPollInterval(
	rows: UploadedTranscriptRow[],
	removedIds: ReadonlySet<string>,
): number | false {
	return rows.some((row) => isProcessing(row) || removedIds.has(row.id))
		? POLL_WHILE_PROCESSING_MS
		: false;
}

function UploadRow({
	row,
	onRemove,
}: {
	row: UploadedTranscriptRow;
	onRemove?: (row: UploadedTranscriptRow, title: string) => void;
}) {
	const metadata = metadataOf(row);
	const title =
		metadata.meetingSubject ?? row.originalFilename ?? "Transcript";
	const failed = row.extractionStatus === "FAILED";

	return (
		<li className="flex items-start justify-between gap-3 p-3">
			<div className="min-w-0">
				<div className="flex flex-wrap items-center gap-2">
					<p className="truncate text-foreground text-sm">{title}</p>
					<Badge status="info">Uploaded file</Badge>
					{isProcessing(row) && (
						<Badge status="warning">Processing</Badge>
					)}
				</div>
				{failed && (
					<p role="alert" className="mt-1 text-destructive text-sm">
						{row.extractionError ??
							"This transcript could not be processed."}
					</p>
				)}
				{(metadata.unreadableParts ?? 0) > 0 && (
					<p className="mt-1 text-muted-foreground text-sm">
						Part of this file could not be read, so this transcript
						may be incomplete.
					</p>
				)}
			</div>
			{onRemove && (
				<Button
					variant="ghost"
					size="sm"
					aria-label={`Remove ${title}`}
					onClick={() => onRemove(row, title)}
				>
					<Trash2Icon className="size-4" />
				</Button>
			)}
		</li>
	);
}

export function TranscriptFileUpload({
	projectId,
	organizationId,
	canEdit = true,
}: {
	projectId: string;
	organizationId: string | null;
	canEdit?: boolean;
}) {
	const queryClient = useQueryClient();
	const { confirm } = useConfirmationAlert();
	const inputRef = useRef<HTMLInputElement>(null);
	const inputId = useId();
	const [isUploading, setIsUploading] = useState(false);
	const [removedIds, setRemovedIds] = useState<ReadonlySet<string>>(
		() => new Set(),
	);

	const { data, isLoading } = useQuery({
		...orpc.projects.contexts.list.queryOptions({
			input: {
				projectId,
				organizationId,
				type: "MEETING_TRANSCRIPT",
			},
		}),
		refetchInterval: (query) =>
			transcriptListPollInterval(
				(query.state.data?.contexts ?? []) as UploadedTranscriptRow[],
				removedIds,
			),
	});

	const uploads = ((data?.contexts ?? []) as UploadedTranscriptRow[]).filter(
		(row) =>
			metadataOf(row).provider === UPLOADED_TRANSCRIPT_PROVIDER &&
			!removedIds.has(row.id),
	);

	const refreshContexts = () =>
		queryClient.invalidateQueries({
			queryKey: orpc.projects.contexts.list.key(),
		});

	const reprocessFiles = async (files: File[]) => {
		for (const file of files) {
			try {
				await uploadTranscriptFile({
					file,
					projectId,
					organizationId,
					reprocess: true,
				});
				toast.success(`Processing ${file.name} again`);
			} catch (error) {
				toast.error(
					error instanceof Error
						? error.message
						: `${file.name} could not be processed.`,
				);
			}
		}
	};

	const handleFiles = async (event: ChangeEvent<HTMLInputElement>) => {
		const picked = Array.from(event.target.files ?? []);
		// Cleared so the same file can be picked again after a failure.
		event.target.value = "";
		if (picked.length === 0) {
			return;
		}

		setIsUploading(true);
		const duplicates: File[] = [];
		for (const file of picked) {
			const problem = transcriptFileProblem(file);
			if (problem) {
				toast.error(problem);
				continue;
			}
			try {
				const outcome = await uploadTranscriptFile({
					file,
					projectId,
					organizationId,
				});
				if (outcome.status === "duplicate") {
					duplicates.push(file);
				} else {
					toast.success(`${file.name} is being processed`);
				}
			} catch (error) {
				toast.error(
					error instanceof Error
						? error.message
						: `${file.name} could not be uploaded.`,
				);
			}
		}
		setIsUploading(false);
		await refreshContexts();

		if (duplicates.length > 0) {
			confirm({
				title: "Already added",
				message: `This project already has ${duplicates
					.map((file) => file.name)
					.join(
						", ",
					)}. Process again to repeat the analysis, or skip to leave it as it is.`,
				confirmLabel: "Process again",
				cancelLabel: "Skip",
				onConfirm: () => reprocessFiles(duplicates),
			});
		}
	};

	const removeUpload = (row: UploadedTranscriptRow, title: string) => {
		confirm({
			title: `Remove ${title}?`,
			message:
				"This removes the transcript and what was extracted from it, including its action items.",
			confirmLabel: "Remove",
			destructive: true,
			onConfirm: async () => {
				try {
					await orpcClient.projects.contexts.delete({
						id: row.id,
						projectId,
					});
				} catch {
					toast.error(`${title} could not be removed.`);
					return;
				}
				setRemovedIds((ids) => new Set(ids).add(row.id));
				await refreshContexts();
			},
		});
	};

	return (
		<div className="space-y-3 border-t p-6">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0">
					<p className="font-medium text-foreground">
						Upload transcripts
					</p>
					<p className="text-muted-foreground text-sm">
						For meetings outside Teams, such as Zoom or Otter
						exports. {GUIDANCE}
					</p>
				</div>
				{canEdit && (
					<>
						<label htmlFor={inputId} className="sr-only">
							Upload transcript files
						</label>
						<input
							ref={inputRef}
							id={inputId}
							type="file"
							multiple
							className="hidden"
							accept={TRANSCRIPT_UPLOAD_ACCEPT_ATTR}
							onChange={handleFiles}
						/>
						<Button
							variant="outline"
							size="sm"
							disabled={isUploading}
							onClick={() => inputRef.current?.click()}
						>
							{isUploading ? (
								<Loader2Icon className="mr-1.5 size-4 animate-spin" />
							) : (
								<UploadIcon className="mr-1.5 size-4" />
							)}
							Upload
						</Button>
					</>
				)}
			</div>

			{uploads.length > 0 ? (
				<ul className="divide-y rounded-lg border">
					{uploads.map((row) => (
						<UploadRow
							key={row.id}
							row={row}
							onRemove={canEdit ? removeUpload : undefined}
						/>
					))}
				</ul>
			) : (
				!isLoading && (
					<p className="text-muted-foreground text-sm">
						No transcripts uploaded yet. Action items and decisions
						appear in the Meeting Digest once a file is processed.
					</p>
				)
			)}
		</div>
	);
}
