"use client";

import {
	FABRIC_IGNORE_FILE,
	parseFrontmatter,
	SNAPSHOT_LIMITS,
} from "@repo/instructions";
import { useDirectCommit } from "@saas/projects/hooks/use-direct-commit";
import { useInstructionActionError } from "@saas/projects/hooks/use-instruction-action-error";
import {
	editInstructionSnapshot,
	type InstructionEdit,
} from "@saas/projects/lib/edit-snapshot";
import type { ChangeMark } from "@saas/projects/lib/instructions-base-changes";
import { defaultCommitMessage } from "@saas/projects/lib/instructions-direct-commit";
import { useConfirmationAlert } from "@saas/shared/components/ConfirmationAlertProvider";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Markdown } from "@ui/components/markdown";
import { Skeleton } from "@ui/components/skeleton";
import { Textarea } from "@ui/components/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { PencilIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { CommitMessageField } from "./CommitMessageField";
import {
	extraFrontmatterFields,
	InstructionFileHeader,
} from "./InstructionFileHeader";
import { InstructionFileToolbar } from "./InstructionFileToolbar";
import { RenameInstructionFileDialog } from "./RenameInstructionFileDialog";

// Script/settings/other files render as plain preformatted text — no
// Markdown or frontmatter parsing, since they are not Markdown documents.
const PLAIN_KINDS = new Set(["SCRIPT", "SETTINGS", "OTHER"]);

/** Resolves true when `text` reached the clipboard, and says which way it went. */
async function copyText(
	text: string,
	copied: string,
	failed: string,
): Promise<boolean> {
	try {
		if (!navigator.clipboard) {
			throw new Error("clipboard unavailable");
		}
		await navigator.clipboard.writeText(text);
		toast.success(copied);
		return true;
	} catch {
		toast.error(failed);
		return false;
	}
}

/**
 * Why a file is editable in the tab and not merely readable.
 *
 * Before this the only way to fix one line of a published tree was to
 * re-upload the whole folder, which needs the folder to hand — so a typo in a
 * skill was a trip back to someone's laptop. An edit here creates a new
 * version through the same derive → upload → verify → scan → publish path an
 * upload takes, so the secret gate, the history and the rejection banner all
 * behave exactly as they do for a folder.
 *
 * Three things are deliberately NOT editable:
 *
 *  - a binary file, which has no text to put in a textarea.
 *  - a file past `maxInlineTextBytes`, or one whose shown body was cut short
 *    (offset paging or the 200,000-character reader cap) — saving a
 *    truncated body would silently delete the rest of the file.
 *  - `.fabricignore`, because it decides what the version excludes and the
 *    validation gate binds it to the snapshot's frozen rules. The server
 *    refuses it too; this is the explanation, not the enforcement.
 *
 * The first two have ONE way out, and the refusal names it: pick the file
 * again with the add control at the same path (`replaceAction`, which is that
 * control's own label for this viewer). The two used to name different routes
 * — "Add file" for one, "upload the folder again" for the other — for what is
 * the same replacement.
 *
 * `file` is always the EFFECTIVE (display) response — the branch's own
 * `written` bytes when the viewer is looking at one, the published file's
 * otherwise — never the published file alone: a branch version can be binary
 * or truncated on its own, independent of whether the published file is, and
 * editing has to be refused on what is actually about to be overwritten.
 */
function editRefusal(
	file: {
		path: string;
		body: string | null;
		size: number;
		truncated: boolean;
	},
	t: (key: string, values?: Record<string, string>) => string,
	replaceAction: string,
	repositoryBacked: boolean,
): string | null {
	if (file.path === FABRIC_IGNORE_FILE) {
		return t(
			repositoryBacked
				? "editFabricignoreRepository"
				: "editFabricignore",
		);
	}
	if (file.body === null) {
		return t("editBinary", { action: replaceAction });
	}
	if (file.truncated || file.size > SNAPSHOT_LIMITS.maxInlineTextBytes) {
		return t("editTooLarge", { action: replaceAction });
	}
	return null;
}

/**
 * Reads one file of the published snapshot, and — for someone who may edit —
 * lets them change, replace or remove it.
 *
 * The header shows the file's CLASSIFIED name/description (`f.name`/
 * `f.description`, set once at ingest — see
 * `packages/database/prisma/queries/instructions.ts`) rather than re-deriving
 * them from the frontmatter block: a file can be classified with a
 * description that isn't itself a `description:` frontmatter key (e.g.
 * inferred from surrounding context), so the stored field is the source of
 * truth and frontmatter parsing below is used only for the metadata rows
 * (`allowed-tools`, `model`, …) that have no dedicated column.
 */
export function InstructionFileView({
	projectId,
	snapshotId,
	currentSnapshotId = snapshotId,
	path,
	canEdit = false,
	canCommit = false,
	canPropose = false,
	repositoryTarget = null,
	existingPaths,
	pausedReason = null,
	change = null,
	publishedVersion = 0,
	onChanged,
	onCommitted,
	onDraftStateChange,
}: {
	projectId: string;
	/** The published snapshot now current, when this pane temporarily holds its predecessor. */
	currentSnapshotId?: string;
	snapshotId: string;
	path: string;
	/**
	 * How the published version differs from the one it was edited from, for
	 * this file: it is new, or its bytes changed. Named in the header's badge
	 * with `publishedVersion`.
	 */
	change?: ChangeMark | null;
	publishedVersion?: number;
	/**
	 * Why every change is paused (a move of the uploaded instructions into a
	 * repository is open, Fizzy #2878 §9): Edit, Rename and Delete stay on the
	 * page, disabled, and pressing one gives this sentence.
	 */
	pausedReason?: string | null;
	/**
	 * Whether to offer Edit and Delete file. A UI gate only: every save goes
	 * through `derive`, which re-checks `INSTRUCTION_CREATE` and the project's
	 * source of truth server-side.
	 */
	canEdit?: boolean;
	/**
	 * Whether this member may commit straight to the synced branch of a
	 * repository-backed project (INSTRUCTION_CREATE; Fizzy #2878 §10). Needs
	 * `repositoryTarget`. Such a project has no versions to save, so the editor
	 * offers Commit to the branch, and a pull request as the alternative.
	 */
	canCommit?: boolean;
	/** The paths of the version on screen, so a rename never lands on a file that exists. */
	existingPaths?: ReadonlySet<string>;
	/** Whether this reader may submit a version for an editor to review. */
	canPropose?: boolean;
	/**
	 * On a repository-backed project, the repository a suggestion opens its
	 * pull request in and the branch it targets (Fizzy #2563 spec §12). The
	 * editor says so before anything is submitted, as the dialog does.
	 */
	repositoryTarget?: { repository: string; ref: string } | null;
	/** Refresh the tab's snapshot list and published pointer after a save. */
	onChanged?: () => void;
	/** A commit landed on the branch: the tab waits for Fabric's copy to take it. */
	onCommitted?: (commit: { sha: string; ref: string }) => void;
	/** Lets the parent retain this exact draft while its next file list loads. */
	onDraftStateChange?: (
		draft: { snapshotId: string; path: string } | null,
	) => void;
}) {
	const actionError = useInstructionActionError();
	const { confirm } = useConfirmationAlert();
	const t = useTranslations("projects.codingInstructions.fileView");
	const kindLabels = t.raw("kindLabels") as Record<string, string>;
	const q = useQuery(
		orpc.projects.instructions.getFile.queryOptions({
			input: {
				projectId,
				snapshotId,
				path,
				offset: 0,
				maxLength: 200_000,
			},
		}),
	);
	/**
	 * The viewer's accepting branch's projection of THIS path (Fizzy #2738
	 * spec §10 "Editor"): a Fabric write whose bytes Fabric holds reads as
	 * "From your branch"; bytes Fabric does not hold (a revert restored a
	 * start version) shows a notice and falls back to the published body —
	 * never a silent substitution. Only relevant on a repository-backed
	 * project, where a member branch can exist at all.
	 */
	const myBranch = useQuery({
		...orpc.projects.instructions.proposals.myBranch.queryOptions({
			input: { projectId },
		}),
		enabled: repositoryTarget !== null,
	});
	const branchEntry = (
		myBranch.data as
			| {
					branch: { id: string } | null;
					files: Array<{
						path: string;
						state: "written" | "deleted" | "restored_unavailable";
					}>;
			  }
			| undefined
	)?.files.find((f) => f.path === path);
	const branchWritten = branchEntry?.state === "written";
	const branchId =
		(myBranch.data as { branch: { id: string } | null } | undefined)?.branch
			?.id ?? null;
	const branchFile = useQuery({
		...orpc.projects.instructions.proposals.myBranchFile.queryOptions({
			input: {
				projectId,
				branchId: branchId ?? "",
				path,
				offset: 0,
				maxLength: 200_000,
			},
		}),
		enabled:
			repositoryTarget !== null && branchWritten && branchId !== null,
	});
	type BranchFileBody = {
		body: string | null;
		url: string | null;
		truncated: boolean;
		nextOffset: number | null;
		size: number;
	};
	const fromBranch = branchWritten
		? (branchFile.data as BranchFileBody | undefined)
		: undefined;
	const showFromBranch = fromBranch !== undefined;
	/**
	 * The `myBranch` projection itself — not just the later `myBranchFile`
	 * read — can be loading or have failed. Until it resolves, whether this
	 * path is even `written` on the branch is unknown, so falling back to
	 * editable published content here is the same silent-substitution risk
	 * `myBranchFile`'s own pending/failed states guard against below: a fast
	 * Edit click could seed a draft from the published body moments before
	 * the projection reveals a branch version underneath it.
	 */
	const myBranchPending = repositoryTarget !== null && myBranch.isLoading;
	const myBranchFailed = repositoryTarget !== null && myBranch.isError;
	/**
	 * A `written` projection promises Fabric-held bytes, but the branch file
	 * query can still be loading or have failed independently of `myBranch`.
	 * Neither falls back to the published body while that is true — that
	 * would be exactly the silent substitution the spec rules out (Fizzy
	 * #2738 spec §10 "Editor") — so the viewer shows why instead, and
	 * editing stays unavailable until the branch bytes resolve one way or
	 * the other. The projection's own loading state is folded in here too,
	 * so the same gate covers both requests with one pair of booleans.
	 */
	const branchFilePending =
		myBranchPending ||
		(branchWritten && !showFromBranch && !branchFile.isError);
	const branchFileFailed =
		!branchFilePending &&
		(myBranchFailed ||
			(branchWritten && !showFromBranch && branchFile.isError));
	const showBranchVersionUnavailable =
		branchEntry?.state === "restored_unavailable";
	const parsed = useMemo(() => {
		const body = showFromBranch ? fromBranch?.body : q.data?.body;
		const kind = q.data?.kind;
		return body != null && kind !== undefined && !PLAIN_KINDS.has(kind)
			? parseFrontmatter(body)
			: null;
	}, [q.data, showFromBranch, fromBranch]);
	// `null` is "not editing". The working copy is seeded from the body when
	// Edit is pressed — never from a render, so a background refetch cannot
	// overwrite what someone has typed.
	//
	// It carries the SNAPSHOT and PATH it was taken from, and a draft for any
	// other pair is not an editable draft. This component is not remounted
	// when either changes:
	//
	//  - the path changes with the tree selection, and without the check the
	//    editor would follow the selection and "Save" would write one file's
	//    text over another;
	//  - the snapshot id changes UNDER the open editor when the tab's poll
	//    sees someone else publish a new version. The draft was read from the
	//    old version, but the save would claim the new one as its base — the
	//    server's own check passes, because that base genuinely is published
	//    — and the teammate's change would be overwritten by text that never
	//    saw it.
	//
	// Comparing here rather than clearing in an effect keeps it a single
	// render with no intermediate state, and keeps the typed text on screen
	// instead of deleting someone's work to protect someone else's.
	const [draft, setDraft] = useState<{
		snapshotId: string;
		path: string;
		text: string;
		/** The commit message once the person has typed one; the default until then. */
		message?: string;
	} | null>(null);
	useEffect(() => {
		onDraftStateChange?.(
			draft === null
				? null
				: { snapshotId: draft.snapshotId, path: draft.path },
		);
	}, [draft, onDraftStateChange]);
	useEffect(() => () => onDraftStateChange?.(null), [onDraftStateChange]);
	const [renameOpen, setRenameOpen] = useState(false);
	/** Whether a commit to the branch is what the editor's primary action does. */
	const committing = canCommit && repositoryTarget !== null;
	// "Suggest as a pull request" for the draft on screen, reached from the
	// branch-moved dialog. A ref, so the hook below is built before the
	// function that needs the loaded file exists.
	const suggestDraftRef = useRef<() => void>(() => undefined);
	const commit = useDirectCommit({
		projectId,
		branch: repositoryTarget?.ref ?? "",
		onChanged: () => onChanged?.(),
		onCommitted,
		onFinished: () => setDraft(null),
	});

	const save = useMutation({
		mutationFn: (input: {
			edits: InstructionEdit[];
			publishOnReady: boolean;
			proposal?: boolean;
		}) =>
			editInstructionSnapshot({
				projectId,
				baseSnapshotId: snapshotId,
				publishOnReady: input.publishOnReady,
				proposal: input.proposal,
				edits: input.edits,
			}),
		onSuccess: (_result, input) => {
			setDraft(null);
			toast.success(
				input.proposal
					? t(
							repositoryTarget
								? "suggestionSubmitted"
								: "proposalSubmitted",
						)
					: t("saved"),
			);
			onChanged?.();
		},
		onError: (error: Error) => toast.error(actionError(error)),
	});

	if (q.isLoading) {
		return <Skeleton className="h-64 w-full" />;
	}
	if (!q.data) {
		return <p className="text-muted-foreground">{t("couldNotLoad")}</p>;
	}
	const f = q.data;
	const extraFields = parsed ? extraFrontmatterFields(parsed.fields) : [];
	const showHeader = Boolean(
		f.name || f.description || extraFields.length > 0,
	);
	const draftForPath = draft?.path === f.path ? draft : null;
	// Saveable only while the version it was taken from is still the one this
	// view is showing.
	const editingText =
		draftForPath?.snapshotId === currentSnapshotId &&
		snapshotId === currentSnapshotId
			? draftForPath.text
			: null;
	// Same text, no longer saveable: the published version moved. Shown
	// read-only with an explanation, so nothing typed is lost and nothing
	// typed can be written against a base it was not read from.
	const staleText =
		draftForPath &&
		(draftForPath.snapshotId !== currentSnapshotId ||
			snapshotId !== currentSnapshotId)
			? draftForPath.text
			: null;
	const editorText = editingText ?? staleText;
	// The read-only body: the branch's `written` bytes when Fabric holds
	// them, the published ones otherwise. Never a silent substitution — a
	// `restored_unavailable` path still shows the published body, under its
	// own notice below.
	const displayBody = showFromBranch ? (fromBranch?.body ?? null) : f.body;
	const displayUrl = showFromBranch ? (fromBranch?.url ?? null) : f.url;
	const displayTruncated = showFromBranch
		? (fromBranch?.truncated ?? false)
		: f.truncated;
	const displayNextOffset = showFromBranch
		? (fromBranch?.nextOffset ?? null)
		: f.nextOffset;
	// Edit eligibility reads the branch's own size once its bytes resolve —
	// a branch version can be larger (or smaller) than the published file it
	// replaces, and "too large to edit" has to be decided on what editing
	// would actually replace.
	const displaySize = showFromBranch ? (fromBranch?.size ?? f.size) : f.size;
	// A `written` projection's own body isn't known yet: editing stays
	// unavailable (Fizzy #2738 spec §10 "Editor") until it resolves, the same
	// disabled-tooltip pattern `editRefusal` already uses. Once it has
	// resolved (or there is no branch to wait on), refusal reads the
	// EFFECTIVE (display) file — the branch's own binary/size/truncated
	// state when the viewer is looking at one, never the published file's.
	const ordinaryRefusal = branchFilePending
		? t("branchFileLoading")
		: branchFileFailed
			? t("branchFileError")
			: editRefusal(
					{
						path: f.path,
						body: displayBody,
						size: displaySize,
						truncated: displayTruncated,
					},
					t,
					// The label of the control that replaces a file for this
					// viewer: the suggest button on a repository project, Add
					// file for an editor, Propose file for a reader.
					t(
						repositoryTarget
							? "replaceActionSuggest"
							: canEdit
								? "replaceActionAdd"
								: "replaceActionPropose",
					),
					repositoryTarget !== null,
				);
	// A paused move says why before anything about this file does.
	const refusal = pausedReason ?? ordinaryRefusal;

	// The commit message the editor shows: what the person typed, else the
	// default for this file.
	const commitMessage =
		draftForPath?.message ??
		defaultCommitMessage({ kind: "update", path: f.path });

	function commitDraft() {
		if (editingText === null || !repositoryTarget) {
			return;
		}
		// The commit is stated against the published file, so that is what an
		// unchanged text is compared with, whatever the editor was seeded from.
		if (editingText === f.body) {
			setDraft(null);
			toast.info(t("noChangesRepository"));
			return;
		}
		commit.start({
			baseSnapshotId: snapshotId,
			message: commitMessage,
			changes: [
				{
					op: "put",
					path: f.path,
					content: editingText,
					encoding: "utf8",
				},
			],
			suggest: canPropose ? () => suggestDraftRef.current() : undefined,
		});
	}

	function commitDeletion() {
		if (!repositoryTarget) {
			return;
		}
		commit.start({
			baseSnapshotId: snapshotId,
			message: defaultCommitMessage({ kind: "delete", path: f.path }),
			changes: [{ op: "delete", path: f.path }],
		});
	}

	function saveDraft(publishOnReady: boolean, proposal = false) {
		if (editingText === null) {
			return;
		}
		// An unchanged body is a no-op, not a version. Publishing one would
		// spend a version number and a whole validation run to say nothing, and
		// the history would fill with versions nobody changed. Compared
		// against the resolved DISPLAY body (the branch's, when the viewer is
		// looking at one) rather than the published body, so a small edit on
		// top of a branch's own content is never mistaken for a no-op, and a
		// save is always diffed against what the editor was actually seeded
		// from.
		if (editingText === displayBody) {
			setDraft(null);
			// Spec §10 Copy: "the 'no changes' refusal gains the withdrawal
			// hint" — a repository suggestion identical to the published file
			// has nothing new to propose; the fix is withdrawing an earlier
			// suggestion, or editing the branch directly, not resubmitting.
			toast.info(
				proposal && repositoryTarget
					? t("noChangesRepositoryHint")
					: t("noChanges"),
			);
			return;
		}
		save.mutate({
			publishOnReady: proposal ? false : publishOnReady,
			proposal,
			edits: [
				{
					op: "put",
					path: f.path,
					// Explicit UTF-8 text: the server re-hashes what arrives, so
					// the bytes hashed here have to be the bytes sent.
					body: new Blob([editingText], { type: "text/plain" }),
				},
			],
		});
	}
	suggestDraftRef.current = () => saveDraft(false, true);
	// The way into an edit: Edit, which the page tour points at as the way to
	// commit on a repository project.
	const editControl = refusal ? (
		/* `aria-disabled`, not `disabled`: a disabled
								   button is not focusable, so the reason would
								   be mouse-only — and a tooltip is the whole
								   point of showing the action at all. Pressing
								   it says why instead of doing nothing. */
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					size="sm"
					variant="outline"
					aria-disabled
					className="opacity-50"
					onClick={() => toast.info(refusal)}
				>
					<PencilIcon className="size-3.5" aria-hidden="true" />
					{t("editButton")}
				</Button>
			</TooltipTrigger>
			<TooltipContent>{refusal}</TooltipContent>
		</Tooltip>
	) : (
		<Button
			size="sm"
			variant="outline"
			onClick={() =>
				setDraft({
					snapshotId,
					path: f.path,
					// Seeded from the resolved DISPLAY
					// body — the branch's, when the
					// viewer is looking at one — never
					// the published body underneath
					// it, so a small edit cannot
					// silently overwrite the branch's
					// own change.
					text: displayBody ?? "",
				})
			}
		>
			<PencilIcon className="size-3.5" aria-hidden="true" />
			{t("editButton")}
		</Button>
	);
	const mayChange =
		(canEdit || committing || canPropose) && editorText === null;
	const busy = save.isPending || commit.busy;

	// Delete file, as the File actions menu runs it: a commit to the branch
	// where this member may commit (with a pull request as the alternative for
	// one who may also suggest), a deletion proposal for a reader, a published
	// version for an editor.
	function requestDeletion() {
		if (pausedReason) {
			toast.info(pausedReason);
			return;
		}
		if (committing) {
			confirm({
				title: t("deleteConfirmRepository", {
					path: f.path,
					ref: repositoryTarget?.ref ?? "",
				}),
				message: t("deleteCommitNote", {
					message: defaultCommitMessage({
						kind: "delete",
						path: f.path,
					}),
				}),
				confirmLabel: t("deleteConfirmActionRepository"),
				destructive: true,
				onConfirm: commitDeletion,
				secondaryAction: canPropose
					? {
							label: t("submitSuggestionButton"),
							onSelect: () =>
								save.mutate({
									publishOnReady: false,
									proposal: true,
									edits: [{ op: "delete", path: f.path }],
								}),
						}
					: undefined,
			});
			return;
		}
		const proposal = !canEdit;
		confirm({
			title: t(
				proposal
					? repositoryTarget
						? "deleteSuggestionConfirm"
						: "deleteProposalConfirm"
					: "deleteConfirm",
				{ path: f.path, ...(repositoryTarget ?? {}) },
			),
			confirmLabel: t(
				proposal
					? repositoryTarget
						? "deleteSuggestionAction"
						: "deleteProposalAction"
					: "deleteConfirmAction",
			),
			destructive: true,
			onConfirm: () =>
				save.mutate({
					publishOnReady: !proposal,
					proposal,
					edits: [{ op: "delete", path: f.path }],
				}),
		});
	}

	return (
		<div className="flex h-full min-w-0 flex-col overflow-hidden rounded-lg border border-border">
			<InstructionFileToolbar
				path={f.path}
				kindLabel={kindLabels[f.kind] ?? kindLabels.OTHER ?? f.kind}
				fromBranch={editorText === null && showFromBranch}
				change={change}
				version={publishedVersion}
				size={displaySize}
				onCopyPath={() =>
					copyText(f.path, t("copied"), t("copyFailed"))
				}
				edit={
					mayChange ? (
						committing ? (
							<span
								className="inline-flex"
								data-onboarding-target="coding-instructions-commit"
							>
								{editControl}
							</span>
						) : (
							editControl
						)
					) : null
				}
				menu={
					mayChange
						? {
								rename: repositoryTarget
									? {
											onSelect: () =>
												refusal
													? toast.info(refusal)
													: setRenameOpen(true),
											refusal,
											busy,
										}
									: undefined,
								delete: {
									onSelect: requestDeletion,
									refusal: pausedReason,
									busy,
								},
							}
						: null
				}
			/>
			{/* What became of a commit: the "Committing…" pill while it waits and,
			    when the branch refused the push, the pull request it became.
			    Outside the editor, so the notice outlives the draft it closed. */}
			<div className="flex flex-col gap-3 px-5 pt-4 empty:hidden">
				{commit.status}
			</div>
			{repositoryTarget ? (
				<RenameInstructionFileDialog
					key={`${f.path}@${snapshotId}`}
					open={renameOpen}
					onOpenChange={setRenameOpen}
					projectId={projectId}
					baseSnapshotId={snapshotId}
					path={f.path}
					content={displayBody}
					existingPaths={existingPaths}
					repositoryTarget={repositoryTarget}
					canCommit={committing}
					canPropose={canPropose}
					onChanged={() => onChanged?.()}
					onCommitted={onCommitted}
				/>
			) : null}
			{editorText !== null ? (
				/* The editor replaces the rendered body rather than sitting beside
				   it: a markdown preview next to the source would be a second
				   thing to keep in step for a change that is usually one line. */
				<div className="flex min-h-0 flex-1 flex-col gap-3 p-5">
					{staleText !== null ? (
						<p
							role="alert"
							className="rounded-lg border border-border bg-muted/40 p-3 text-muted-foreground text-sm"
						>
							{t(
								committing
									? "staleNoticeRepository"
									: "staleNotice",
								{
									ref: repositoryTarget?.ref ?? "",
								},
							)}
						</p>
					) : null}
					<Textarea
						aria-label={t("editorLabel", { path: f.path })}
						value={editorText}
						readOnly={staleText !== null}
						onChange={(e) =>
							setDraft({
								snapshotId,
								path: f.path,
								text: e.target.value,
								message: draftForPath?.message,
							})
						}
						spellCheck={false}
						className="min-h-[320px] flex-1 font-mono text-xs"
					/>
					{staleText !== null ? (
						/* No save of any kind: the only way on from here is to
						   discard and press Edit again, which reads the new
						   version's body. */
						<div className="flex items-center gap-2">
							<Button
								size="sm"
								variant="outline"
								onClick={() => setDraft(null)}
							>
								{t("discardButton")}
							</Button>
						</div>
					) : (
						<div className="flex flex-col gap-2">
							{repositoryTarget && (committing || canPropose) ? (
								<p className="text-muted-foreground text-sm">
									{t(
										committing
											? "commitNotice"
											: "repositoryProposalNotice",
										repositoryTarget,
									)}
								</p>
							) : null}
							{committing ? (
								<CommitMessageField
									value={commitMessage}
									refusal={commit.messageRefusal}
									disabled={save.isPending || commit.busy}
									onChange={(message) => {
										commit.clearMessageRefusal();
										setDraft({
											snapshotId,
											path: f.path,
											text: editorText,
											message,
										});
									}}
								/>
							) : null}
							<div className="flex flex-wrap items-center gap-2">
								{canEdit ? (
									<>
										<Button
											size="sm"
											disabled={save.isPending}
											onClick={() => saveDraft(true)}
										>
											{t("saveAndPublishButton")}
										</Button>
										<Button
											size="sm"
											variant="outline"
											disabled={save.isPending}
											onClick={() => saveDraft(false)}
										>
											{t("saveAsVersionButton")}
										</Button>
									</>
								) : null}
								{committing ? (
									<Button
										size="sm"
										data-onboarding-target="coding-instructions-commit"
										disabled={
											save.isPending ||
											commit.busy ||
											commitMessage.trim() === ""
										}
										onClick={commitDraft}
									>
										{t("saveAndPublishButtonRepository", {
											ref: repositoryTarget?.ref ?? "",
										})}
									</Button>
								) : null}
								{canPropose ? (
									<Button
										size="sm"
										variant={
											canEdit || committing
												? "outline"
												: "default"
										}
										disabled={save.isPending || commit.busy}
										onClick={() => saveDraft(false, true)}
									>
										{t(
											repositoryTarget
												? "submitSuggestionButton"
												: "submitProposalButton",
										)}
									</Button>
								) : null}
								<Button
									size="sm"
									variant="ghost"
									disabled={save.isPending || commit.busy}
									onClick={() => setDraft(null)}
								>
									{t("cancelButton")}
								</Button>
							</div>
						</div>
					)}
				</div>
			) : (
				<div className="min-w-0 overflow-auto px-7 py-6 [overflow-wrap:anywhere]">
					{/* A reading column: a long line of prose is hard to follow, so
					    the file's text stops near 72 characters however wide the
					    pane is. */}
					<div className="flex max-w-[72ch] min-w-0 flex-col gap-4">
						{branchFilePending || branchFileFailed ? (
							// A `written` projection promises Fabric-held bytes
							// this view has not resolved yet: showing the
							// published body underneath would be exactly the
							// silent substitution the spec rules out, so this
							// says why instead (Fizzy #2738 spec §10 "Editor").
							<p
								role={branchFileFailed ? "alert" : "status"}
								className="rounded-lg border border-border bg-muted/40 p-3 text-muted-foreground text-sm"
							>
								{t(
									branchFileFailed
										? "branchFileError"
										: "branchFileLoading",
								)}
							</p>
						) : (
							<>
								{showHeader ? (
									<InstructionFileHeader
										name={f.name}
										description={f.description}
										fields={parsed ? parsed.fields : null}
										extraFields={extraFields}
									/>
								) : null}
								{showBranchVersionUnavailable ? (
									<p
										role="alert"
										className="rounded-lg border border-border bg-muted/40 p-3 text-muted-foreground text-sm"
									>
										{t("branchVersionUnavailable")}
									</p>
								) : null}
								{displayBody == null ? (
									<p className="text-muted-foreground">
										{t("binaryFile")}{" "}
										{displayUrl ? (
											<a
												href={displayUrl}
												target="_blank"
												rel="noopener noreferrer"
												className="underline"
											>
												{t("downloadIt")}
											</a>
										) : null}
									</p>
								) : PLAIN_KINDS.has(f.kind) ? (
									<pre className="whitespace-pre-wrap font-mono text-xs">
										{displayBody}
									</pre>
								) : (
									<Markdown>
										{parsed ? parsed.body : displayBody}
									</Markdown>
								)}
								{displayTruncated ? (
									<p className="text-muted-foreground text-xs">
										{t("truncated", {
											offset: displayNextOffset ?? 0,
										})}
									</p>
								) : null}
							</>
						)}
					</div>
				</div>
			)}
		</div>
	);
}
