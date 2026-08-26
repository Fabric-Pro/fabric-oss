"use client";

import {
	ATTACHMENT_ACCEPT_ATTR,
	EXCALIDRAW_MIME,
	extensionForMime,
	humanFileSize,
} from "@repo/utils/attachment";
import {
	isAiContextEligibleAttachmentMime,
	STORY_ATTACHMENT_AI_CONTEXT_MIME_TYPES,
} from "@repo/utils/story-attachment-ai-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	LockIcon,
	PaperclipIcon,
	PencilRulerIcon,
	TrashIcon,
	UnlockIcon,
} from "lucide-react";
import { useRef, useState } from "react";
import {
	type StoryAttachmentDto,
	uploadStoryAttachment,
} from "../../../lib/attachment-upload-utils";
import type { UserStory } from "../../../lib/stories/types";
import {
	storyAttachmentsQueryKey,
	storyAttachmentsQueryOptions,
} from "../../../lib/story-attachments-query";

/** The designation that makes a file readable by the AI. */
const CONTEXT_ONLY_DESIGNATION = "UNLOCKED" as const;

/** Display names for the PM server keys that can own an attachment. */
const SOURCE_TOOL_LABELS: Record<string, string> = {
	"azure-devops": "ADO",
	jira: "Jira",
	fizzy: "Fizzy",
};

function sourceToolLabel(sourceTool: string | null): string | null {
	if (!sourceTool) {
		return null;
	}
	// `sourceTool` is a free-form `String?` column, so a plain index read
	// (`SOURCE_TOOL_LABELS[sourceTool]`) walks the prototype chain: a value of
	// "constructor" or "toString" resolves to an inherited builtin instead of
	// `undefined`, and `??` never falls back — the badge would render a
	// stringified function. `Object.hasOwn` restricts the lookup to the
	// object's own keys.
	return Object.hasOwn(SOURCE_TOOL_LABELS, sourceTool)
		? SOURCE_TOOL_LABELS[sourceTool]
		: sourceTool;
}

/**
 * A Fabric-origin row is implicitly promoted. Only a PM_SYNCED row with no
 * `promotedAt` is the read-only, promotable state (Fizzy #1746, AC-7).
 */
function isUnpromotedInbound(a: {
	source: "FABRIC" | "PM_SYNCED";
	promotedAt: Date | string | null;
}): boolean {
	return a.source === "PM_SYNCED" && a.promotedAt == null;
}

/**
 * Human-facing summary of what the resolver will actually extract, derived
 * from the resolver's own set. The hand-written version drifted — it omitted
 * .xlsx after spreadsheets became eligible, telling users the AI could not
 * read a file it could. #1684.
 */
const CONTEXT_ONLY_READABLE_FORMATS =
	STORY_ATTACHMENT_AI_CONTEXT_MIME_TYPES.map((mime) => extensionForMime(mime))
		.filter((ext): ext is string => ext !== null)
		.map((ext) => `.${ext}`)
		.join(", ");

type Props = {
	story: UserStory;
	projectId: string;
	organizationId: string | null;
	canEdit: boolean;
};

export function AttachmentsTab({
	story,
	projectId,
	organizationId,
	canEdit,
}: Props) {
	const qc = useQueryClient();
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [error, setError] = useState<string | null>(null);
	const [lockedPromptId, setLockedPromptId] = useState<string | null>(null);
	// IDs with a promote in flight. There is ONE shared `promoteMutation`
	// instance, and TanStack Query v5's MutationObserver re-points
	// `mutation.variables` to the newest call — so `promoteMutation.variables
	// === a.id` looks per-row but isn't: promoting row A then row B before A
	// returns makes A's guard go false while A is still in flight. A `Set`
	// (not a single id) is required because two rows can be genuinely
	// in-flight at once. Fizzy #1746.
	const [promotingIds, setPromotingIds] = useState<Set<string>>(new Set());

	const queryKey = storyAttachmentsQueryKey(
		projectId,
		story.id,
		organizationId,
	);
	const listQuery = useQuery(
		storyAttachmentsQueryOptions({
			projectId,
			storyId: story.id,
			organizationId,
		}),
	);
	const attachments: StoryAttachmentDto[] = listQuery.data?.attachments ?? [];

	// Opt-in per upload, defaulting off. `designation` governs deletion as well
	// as AI visibility, so defaulting this on would quietly strip new files of
	// the delete protection LOCKED gives them — an unrelated behavior change
	// riding along with an AI feature. The user says which they want instead.
	const [uploadAsContextOnly, setUploadAsContextOnly] = useState(false);

	const uploadMutation = useMutation({
		mutationFn: async (file: File) => {
			const r = await uploadStoryAttachment({
				file,
				projectId,
				userStoryId: story.id,
				organizationId,
				// Omitted => server default LOCKED (protected asset).
				...(uploadAsContextOnly
					? { designation: CONTEXT_ONLY_DESIGNATION }
					: {}),
			});
			await qc.invalidateQueries({ queryKey });
			return r;
		},
		onError: (e) =>
			setError(e instanceof Error ? e.message : "Upload failed"),
	});

	const removeMutation = useMutation({
		mutationFn: async (attachmentId: string) => {
			await orpcClient.projects.stories.removeAttachment({
				projectId,
				userStoryId: story.id,
				organizationId,
				attachmentId,
			});
			await qc.invalidateQueries({ queryKey });
		},
		onError: (e) =>
			setError(e instanceof Error ? e.message : "Remove failed"),
	});

	const toggleMutation = useMutation({
		mutationFn: async (vars: {
			attachmentId: string;
			designation: "LOCKED" | "UNLOCKED";
		}) => {
			await orpcClient.projects.stories.setAttachmentDesignation({
				projectId,
				userStoryId: story.id,
				organizationId,
				...vars,
			});
			await qc.invalidateQueries({ queryKey });
		},
	});

	const promoteMutation = useMutation({
		mutationFn: async (attachmentId: string) => {
			await orpcClient.projects.stories.promoteAttachment({
				projectId,
				userStoryId: story.id,
				organizationId,
				attachmentId,
			});
		},
		onSuccess: () => setError(null),
		onError: (e) =>
			setError(e instanceof Error ? e.message : "Promote failed"),
		// Runs on BOTH success and failure. The invalidate used to sit after
		// the awaited call inside `mutationFn`, so a rejection threw past it
		// and the row kept rendering a stale, re-clickable Promote button
		// forever. `onSettled` always runs.
		onSettled: (_data, _error, attachmentId) => {
			qc.invalidateQueries({ queryKey });
			setPromotingIds((prev) => {
				if (!prev.has(attachmentId)) {
					return prev;
				}
				const next = new Set(prev);
				next.delete(attachmentId);
				return next;
			});
		},
	});

	const handleFiles = (files: FileList | null) => {
		setError(null);
		if (!files) {
			return;
		}
		for (const file of Array.from(files)) {
			uploadMutation.mutate(file);
		}
	};

	const handleRemove = (a: StoryAttachmentDto) => {
		if (a.designation === "LOCKED") {
			setLockedPromptId(a.id);
			return;
		}
		removeMutation.mutate(a.id);
	};

	return (
		<div className="space-y-4">
			<p className="app-editorial-label">
				Attachments ({attachments.length})
			</p>

			{canEdit && (
				<div
					role="button"
					tabIndex={0}
					aria-label="Drag files here or use the Browse button to upload"
					onClick={() => fileInputRef.current?.click()}
					onDragOver={(e) => e.preventDefault()}
					onDrop={(e) => {
						e.preventDefault();
						handleFiles(e.dataTransfer.files);
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							fileInputRef.current?.click();
						}
					}}
					className="rounded-lg border border-dashed border-border/60 bg-muted/40 p-4 text-center text-muted-foreground text-sm"
				>
					Drag &amp; drop files here, or{" "}
					<Button
						type="button"
						variant="link"
						className="h-auto p-0"
						onClick={(e) => {
							e.stopPropagation();
							fileInputRef.current?.click();
						}}
					>
						Browse
					</Button>
					<input
						ref={fileInputRef}
						type="file"
						multiple
						accept={ATTACHMENT_ACCEPT_ATTR}
						className="sr-only"
						onChange={(e) => {
							handleFiles(e.target.files);
							e.target.value = "";
						}}
					/>
				</div>
			)}

			{canEdit && (
				<label className="flex items-start gap-2 text-muted-foreground text-xs">
					<input
						type="checkbox"
						checked={uploadAsContextOnly}
						onChange={(e) =>
							setUploadAsContextOnly(e.target.checked)
						}
						className="mt-0.5 shrink-0"
					/>
					<span>
						Upload as{" "}
						<span className="font-medium text-foreground">
							Context only
						</span>{" "}
						— the AI reads these files. They can also be deleted
						without unlocking. Text formats only ({" "}
						{CONTEXT_ONLY_READABLE_FORMATS}).
					</span>
				</label>
			)}

			<div aria-live="polite">
				{uploadMutation.isPending && (
					<p className="text-muted-foreground text-xs">Uploading…</p>
				)}
				{error && <p className="text-destructive text-xs">{error}</p>}
			</div>

			{attachments.length === 0 ? (
				<p className="text-muted-foreground text-sm">No attachments.</p>
			) : (
				<ul className="space-y-2">
					{attachments.map((a) => (
						<li
							key={a.id}
							className="flex items-center gap-2 text-sm"
						>
							{a.mimeType === EXCALIDRAW_MIME ? (
								<PencilRulerIcon
									className="size-4 shrink-0 text-primary"
									aria-hidden
								/>
							) : (
								<PaperclipIcon
									className="size-4 shrink-0 text-muted-foreground"
									aria-hidden
								/>
							)}
							<span className="min-w-0 flex-1 truncate">
								{a.filename}
								{/*
								 * Keyed on `source === "PM_SYNCED"`, the SAME
								 * column `isUnpromotedInbound` reads — not on
								 * `sourceTool` alone. Once outbound push (PR 2)
								 * stamps `sourceTool` on a Fabric upload it just
								 * pushed, a bare `sourceTool` check would label a
								 * file the user uploaded in Fabric "From Jira".
								 *
								 * No `title` here: the visible text alone carries
								 * the un-promoted/promoted distinction ("From X"
								 * vs "Originally from X"). A `title` duplicating
								 * that text would make a screen reader announce
								 * the same provenance twice (label + title).
								 */}
								{a.source === "PM_SYNCED" &&
									sourceToolLabel(a.sourceTool) && (
										<span className="ml-2 rounded bg-muted px-1.5 py-0.5 align-middle text-[10px] text-muted-foreground">
											{isUnpromotedInbound(a)
												? `From ${sourceToolLabel(a.sourceTool)}`
												: `Originally from ${sourceToolLabel(a.sourceTool)}`}
										</span>
									)}
								{a.mimeType === EXCALIDRAW_MIME && (
									<span className="ml-2 rounded bg-muted px-1.5 py-0.5 align-middle text-[10px] text-muted-foreground uppercase tracking-wide">
										Excalidraw
									</span>
								)}
								{/*
								 * State, not just an icon. The lock glyph's
								 * aria-label names the ACTION ("Lock notes.md"),
								 * so without this a context-only file and a
								 * protected one differ only by a glyph — which
								 * fails the not-by-colour-alone bar and tells a
								 * screen-reader user nothing about which files
								 * the AI can see.
								 */}
								{a.designation === "UNLOCKED" && (
									<span className="ml-2 rounded bg-muted px-1.5 py-0.5 align-middle text-[10px] text-muted-foreground">
										Context only
									</span>
								)}
								{/*
								 * Marked context-only, but nothing extracts text
								 * from this format — so the AI never receives it.
								 * Without saying so, the badge above promises
								 * something the pipeline does not deliver, and the
								 * user believes the model read their screenshot.
								 */}
								{a.designation === "UNLOCKED" &&
									!isAiContextEligibleAttachmentMime(
										a.mimeType,
									) && (
										<span className="ml-2 rounded bg-muted px-1.5 py-0.5 align-middle text-[10px] text-muted-foreground">
											Not read by AI
										</span>
									)}
							</span>
							<span className="shrink-0 text-muted-foreground text-xs">
								{humanFileSize(a.sizeBytes)}
							</span>
							{a.downloadUrl ? (
								<a
									href={a.downloadUrl}
									className="shrink-0 text-primary text-xs underline"
									aria-label={`Download ${a.filename}`}
								>
									Download
								</a>
							) : (
								<span className="shrink-0 text-destructive text-xs">
									Unavailable
								</span>
							)}
							{canEdit && isUnpromotedInbound(a) && (
								<Button
									variant="outline"
									size="sm"
									className="shrink-0"
									// `mutate()` returns void, so Button's default
									// autoLoading (which only engages for a
									// promise-returning onClick) never fires here.
									// Explicit disabled matches the convention used
									// for mutate()-backed buttons elsewhere (e.g.
									// DiagramsList's create button) — without it a
									// double-click sends a second promote that the
									// backend's `promotedAt: null` filter turns into
									// a spurious NOT_FOUND. Fizzy #1746.
									//
									// Tracked in the `promotingIds` component state,
									// NOT `promoteMutation.variables` — there is one
									// shared mutation instance, and TanStack Query
									// re-points `variables` to the newest call, so a
									// `variables === a.id` check goes false for row
									// A the moment row B is promoted while A is
									// still in flight.
									disabled={promotingIds.has(a.id)}
									onClick={() => {
										setPromotingIds((prev) =>
											new Set(prev).add(a.id),
										);
										promoteMutation.mutate(a.id);
									}}
								>
									Promote
								</Button>
							)}
							{canEdit && !isUnpromotedInbound(a) && (
								<>
									<button
										type="button"
										// `aria-pressed` carries the STATE; the
										// label carries the action. Without it a
										// screen reader hears only "Lock notes.md"
										// and cannot tell whether the file is
										// currently context-only or protected.
										aria-pressed={
											a.designation === "UNLOCKED"
										}
										aria-label={
											a.designation === "LOCKED"
												? `Unlock ${a.filename}`
												: `Lock ${a.filename}`
										}
										onClick={() =>
											toggleMutation.mutate({
												attachmentId: a.id,
												designation:
													a.designation === "LOCKED"
														? "UNLOCKED"
														: "LOCKED",
											})
										}
										className="shrink-0 text-muted-foreground hover:text-foreground"
									>
										{a.designation === "LOCKED" ? (
											<LockIcon className="size-4" />
										) : (
											<UnlockIcon className="size-4" />
										)}
									</button>
									<button
										type="button"
										aria-label={`Remove ${a.filename}`}
										onClick={() => handleRemove(a)}
										className="shrink-0 text-muted-foreground hover:text-destructive"
									>
										<TrashIcon className="size-4" />
									</button>
								</>
							)}
							{lockedPromptId === a.id && (
								<span className="shrink-0 text-highlight text-xs">
									Unlock this file before removing it
								</span>
							)}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
