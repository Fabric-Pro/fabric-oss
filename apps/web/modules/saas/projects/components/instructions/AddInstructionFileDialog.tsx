"use client";

import {
	FABRIC_IGNORE_FILE,
	isSecretFileName,
	type PathRejectReason,
	type PortableNameRejectReason,
	type ProposalNote,
	proposalNoteSchema,
	SNAPSHOT_LIMITS,
	validatePortableName,
	validateRelativePath,
} from "@repo/instructions";
import {
	type CommittedCallback,
	type RereadCallback,
	useDirectCommit,
} from "@saas/projects/hooks/use-direct-commit";
import { useInstructionActionError } from "@saas/projects/hooks/use-instruction-action-error";
import { editInstructionSnapshot } from "@saas/projects/lib/edit-snapshot";
import type { InstructionChangeBase } from "@saas/projects/lib/instruction-change-source";
import {
	COMMIT_MAX_INLINE_BYTES,
	defaultCommitMessage,
	fileToBase64,
} from "@saas/projects/lib/instructions-direct-commit";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { Textarea } from "@ui/components/textarea";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { CommitMessageField } from "./CommitMessageField";
import { invalidateProposalViews } from "./lib/instructions-proposal-views";
import { PublishBeforeScanOption } from "./PublishBeforeScanOption";

/** The admission refusals the dialog names with its own copy (spec §5.3). */
/**
 * A button named after a branch can be longer than the dialog is wide: it
 * wraps its label instead of pushing the dialog's edge out.
 */
export const WRAPPING_BUTTON =
	"h-auto min-h-9 whitespace-normal py-1.5 text-left";

const ADMISSION_REFUSALS = new Set([
	"REPOSITORY_UNAVAILABLE",
	"REPOSITORY_BASE_UNAVAILABLE",
	"REPOSITORY_SOURCE_OF_TRUTH",
]);

type NoteField = "title" | "body";

/**
 * The note as the proposer typed it, or undefined when both fields are
 * empty. The title is trimmed (a title of spaces is no title); the body is
 * kept as written, since its line breaks are the point.
 */
function noteFrom(title: string, body: string): ProposalNote | undefined {
	const trimmedTitle = title.trim();
	const note: ProposalNote = {
		...(trimmedTitle ? { title: trimmedTitle } : {}),
		...(body.trim() ? { body } : {}),
	};
	return note.title === undefined && note.body === undefined
		? undefined
		: note;
}

/**
 * Which field the shared note schema refuses, previewed client-side. The
 * server re-checks with the same schema and also scans for credentials,
 * which only it can do (`NOTE_REJECTED`, shown under its field).
 */
function noteRefusalField(note: ProposalNote | undefined): NoteField | null {
	if (!note) {
		return null;
	}
	const parsed = proposalNoteSchema.safeParse(note);
	if (parsed.success) {
		return null;
	}
	return parsed.error.issues[0]?.path[0] === "body" ? "body" : "title";
}

function refusalData(
	error: unknown,
): { reason?: string; field?: string } | undefined {
	if (error && typeof error === "object" && "data" in error) {
		const data = (error as { data?: unknown }).data;
		return data && typeof data === "object"
			? (data as { reason?: string; field?: string })
			: undefined;
	}
	return undefined;
}

/**
 * The destination path this dialog proposes for a picked file.
 *
 * A file picked into a selected folder lands INSIDE it, which is what someone
 * who clicked "Add file" with `.claude/skills/review/` open expects; with
 * nothing selected it lands at the tree root. It is a default, not a
 * constraint — the field is editable, and the server validates whatever is
 * finally sent.
 */
export function proposedPath(fileName: string, folder: string | null): string {
	return folder ? `${folder.replace(/\/+$/, "")}/${fileName}` : fileName;
}

/**
 * Why a path cannot be added: a validator's own reason, or one of the two
 * refusals this dialog adds. A CODE, never a sentence — the component words it
 * from `addFileDialog.pathRefusals`, so no validator vocabulary ("traversal",
 * "reserved_device_name") reaches the screen.
 */
export type PathRefusalCode =
	| PathRejectReason
	| PortableNameRejectReason
	| "fabricignore"
	| "secret";

/**
 * The reason a path cannot be added, previewed client-side, or null.
 *
 * Every one of these is re-checked by `derive` on the server, which is the
 * authority. Checking here means a mistyped path is reported before a file is
 * read and a version is registered, rather than as a refused request.
 */
export function pathRefusal(path: string): PathRefusalCode | null {
	const v = validateRelativePath(path);
	if (!v.ok) {
		return v.reason;
	}
	if (v.path === FABRIC_IGNORE_FILE) {
		return "fabricignore";
	}
	// This dialog only ever ADDS or REPLACES a file, so the portability rules
	// apply to every path it accepts. A delete goes through a different
	// control and is deliberately exempt, because a grandfathered name has to
	// stay removable.
	const portable = validatePortableName(v.path);
	if (!portable.ok) {
		return portable.reason;
	}
	if (isSecretFileName(v.path)) {
		return "secret";
	}
	return null;
}

/**
 * Adds ONE file to the published version, or replaces one at an existing path.
 *
 * A single-file picker rather than a folder one: this is the counterpart of
 * editing a file, not a second way to upload a tree. Replacing the whole tree
 * is still "Replace", which re-resolves the project's live ignore settings and
 * re-freezes them; this derivation keeps the published version's frozen rules,
 * which is why a path those rules exclude is refused rather than silently
 * dropped.
 *
 * It is also how a BINARY file is replaced, since the in-place editor is text
 * only: pick the new file, keep the existing path.
 *
 * A proposal carries an optional note (title and description, Fizzy #2563
 * spec §5.1 step 6). On a repository-backed project the dialog is "Suggest a
 * change": it names the repository and branch the pull request opens
 * against, and says the branch is pushed with the connection's credentials
 * and can start CI before review (spec §12).
 */
export function AddInstructionFileDialog({
	projectId,
	baseSnapshotId,
	nativeBase,
	open,
	onOpenChange,
	folder,
	proposalOnly = false,
	canPropose = false,
	repositoryTarget = null,
	canPublishBeforeScan = false,
	canCommit = false,
	onAdded,
	onCommitted,
}: {
	projectId: string;
	/** The published snapshot the new version is derived from. */
	open: boolean;
	onOpenChange: (o: boolean) => void;
	/** The folder currently selected in the tree, if any. */
	folder: string | null;
	/** Reader mode: this file can only be submitted for review. */
	proposalOnly?: boolean;
	/** Editors may also choose review instead of a direct version. */
	canPropose?: boolean;
	/**
	 * The repository a suggestion opens its pull request in, and the branch
	 * it targets, on a repository-backed project. Null for an upload-backed
	 * one.
	 */
	repositoryTarget?: { repository: string; ref: string } | null;
	/**
	 * Offer "publish now and scan afterwards" on a direct version (Fizzy
	 * #2737): only for a member who may publish (INSTRUCTION_UPDATE), never on
	 * a proposal. A UI gate; `derive` re-checks it.
	 */
	canPublishBeforeScan?: boolean;
	/**
	 * Commit the file straight to the synced branch (INSTRUCTION_CREATE on a
	 * repository-backed project; Fizzy #2878 §10), with a pull request as the
	 * alternative. Needs `repositoryTarget`. A UI gate; `commitChange`
	 * re-checks.
	 */
	canCommit?: boolean;
	onAdded: RereadCallback;
	/** A commit landed on the branch: the tab waits for Fabric's copy to take it. */
	onCommitted?: CommittedCallback;
} & InstructionChangeBase) {
	const actionError = useInstructionActionError();
	const t = useTranslations("projects.codingInstructions.addFileDialog");
	const tDirect = useTranslations("projects.codingInstructions.direct");
	const inputRef = useRef<HTMLInputElement>(null);
	const [file, setFile] = useState<File | null>(null);
	const [path, setPath] = useState("");
	const [publishOnReady, setPublishOnReady] = useState(true);
	const [publishBeforeScan, setPublishBeforeScan] = useState(false);
	const [acknowledged, setAcknowledged] = useState(false);
	const [noteTitle, setNoteTitle] = useState("");
	const [noteBody, setNoteBody] = useState("");
	// The server's NOTE_REJECTED, shown under the field it names until that
	// field is edited. Only the field is kept: the server's message is not
	// translated and is never shown.
	const [serverNoteRefusal, setServerNoteRefusal] = useState<{
		field: NoteField;
	} | null>(null);
	const offersProposal = proposalOnly || canPropose;
	// A repository project has no versions to publish: the file is committed
	// to its branch, or suggested as a pull request.
	const commitMode = canCommit && repositoryTarget !== null;
	const [message, setMessage] = useState<string | null>(null);
	const [pullRequestOpened, setPullRequestOpened] = useState(false);
	const [reading, setReading] = useState(false);
	// A direct version only: the option is not rendered in reader mode, and a
	// proposal never sends it.
	const fastPath =
		canPublishBeforeScan &&
		!proposalOnly &&
		publishOnReady &&
		publishBeforeScan;

	function reset() {
		setFile(null);
		setPath("");
		setPublishOnReady(true);
		setPublishBeforeScan(false);
		setAcknowledged(false);
		setNoteTitle("");
		setNoteBody("");
		setServerNoteRefusal(null);
		setMessage(null);
		setPullRequestOpened(false);
		if (inputRef.current) {
			inputRef.current.value = "";
		}
	}

	const note = noteFrom(noteTitle, noteBody);
	const queryClient = useQueryClient();
	const add = useMutation({
		mutationFn: ({
			picked,
			proposal,
		}: {
			picked: File;
			proposal: boolean;
		}) =>
			editInstructionSnapshot({
				projectId,
				...(nativeBase ? { nativeBase } : { baseSnapshotId }),
				publishOnReady: proposal ? false : publishOnReady,
				proposal,
				// A direct version stores no note, so none is sent with one.
				...(proposal && note ? { note } : {}),
				...(proposal && commitMode && message ? { message } : {}),
				...(!proposal && fastPath ? { publishBeforeScan: true } : {}),
				edits: [{ op: "put", path: path.trim(), body: picked }],
			}),
		onSuccess: (_result, input) => {
			toast.success(
				input.proposal && nativeBase
					? tDirect("suggestionSubmitted")
					: input.proposal
						? t(
								repositoryTarget
									? "pullRequestSubmitted"
									: "proposalSubmitted",
							)
						: t("added"),
			);
			if (input.proposal) {
				void invalidateProposalViews(queryClient);
			}
			reset();
			onOpenChange(false);
			onAdded();
		},
		onError: (error: Error) => {
			const data = refusalData(error);
			if (data?.reason === "NOTE_REJECTED") {
				setServerNoteRefusal({
					field: data.field === "body" ? "body" : "title",
				});
				return;
			}
			toast.error(
				data?.reason && ADMISSION_REFUSALS.has(data.reason)
					? t(`refusals.${data.reason}`)
					: actionError(error),
			);
		},
	});

	const commit = useDirectCommit({
		projectId,
		branch: repositoryTarget?.ref ?? "",
		onChanged: onAdded,
		onCommitted,
		onFinished: (result) => {
			// A pull request keeps the dialog open: its link is the next step.
			if (result.kind === "pull-request") {
				setPullRequestOpened(true);
				return;
			}
			reset();
			onOpenChange(false);
		},
	});
	const defaultMessage = defaultCommitMessage({
		kind: "add",
		path: path.trim(),
	});
	const commitMessage = message ?? defaultMessage;

	const tooLargeToCommit =
		commitMode && file !== null && file.size > COMMIT_MAX_INLINE_BYTES;
	const tooLarge = file !== null && file.size > SNAPSHOT_LIMITS.maxFileBytes;
	const refusalCode =
		path.trim().length > 0 ? pathRefusal(path.trim()) : null;
	const refusal =
		refusalCode === null ? null : t(`pathRefusals.${refusalCode}`);
	const noteField = offersProposal ? noteRefusalField(note) : null;
	const titleError =
		noteField === "title"
			? t("noteTitleInvalid")
			: serverNoteRefusal?.field === "title"
				? t("noteTitleRejected")
				: null;
	const bodyError =
		noteField === "body"
			? t("noteBodyInvalid")
			: serverNoteRefusal?.field === "body"
				? t("noteBodyRejected")
				: null;
	const canSubmit =
		file !== null &&
		path.trim().length > 0 &&
		!tooLarge &&
		refusal === null &&
		!add.isPending &&
		!commit.busy &&
		!reading;
	// The note only rides with a proposal, so only the proposal button waits
	// on it.
	const canSubmitProposal = canSubmit && noteField === null;

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) {
					reset();
				}
				onOpenChange(next);
			}}
		>
			<DialogContent className="grid-cols-[minmax(0,1fr)]">
				<DialogHeader>
					<DialogTitle className="[overflow-wrap:anywhere]">
						{commitMode
							? t("repositoryCommitTitle", repositoryTarget)
							: repositoryTarget
								? t("repositoryTitle")
								: t("title")}
					</DialogTitle>
					<DialogDescription>
						{commitMode
							? t("repositoryCommitDescription", repositoryTarget)
							: repositoryTarget
								? t("repositoryDescription", repositoryTarget)
								: t("description")}
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-4">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="add-instruction-file">
							{t("fileLabel")}
						</Label>
						<Input
							id="add-instruction-file"
							ref={inputRef}
							type="file"
							onChange={(e) => {
								const picked = e.target.files?.[0] ?? null;
								setFile(picked);
								// Only ever a proposal, and only when the
								// field is untouched: someone who has already
								// typed a destination and then swaps the file
								// must not have their path overwritten.
								if (picked && path.trim().length === 0) {
									setPath(proposedPath(picked.name, folder));
								}
							}}
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="add-instruction-path">
							{t("pathLabel")}
						</Label>
						<Input
							id="add-instruction-path"
							value={path}
							spellCheck={false}
							placeholder={t("pathPlaceholder")}
							onChange={(e) => setPath(e.target.value)}
						/>
						<p className="text-muted-foreground text-xs">
							{t("pathHint")}
						</p>
					</div>
					{tooLargeToCommit ? (
						<p className="text-destructive text-sm">
							{t("commitTooLarge", {
								limit: Math.round(
									COMMIT_MAX_INLINE_BYTES / 1024 / 1024,
								),
							})}
						</p>
					) : null}
					{commitMode && !pullRequestOpened ? (
						<CommitMessageField
							value={commitMessage}
							refusal={commit.messageRefusal}
							disabled={commit.busy || reading}
							onChange={(value) => {
								commit.clearMessageRefusal();
								setMessage(value);
							}}
						/>
					) : null}
					{commit.status}
					{tooLarge ? (
						<p className="text-destructive text-sm">
							{t("tooLarge", {
								limit: Math.round(
									SNAPSHOT_LIMITS.maxFileBytes / 1024 / 1024,
								),
							})}
						</p>
					) : null}
					{refusal ? (
						<p className="text-destructive text-sm">{refusal}</p>
					) : null}
					{offersProposal ? (
						<>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="add-instruction-note-title">
									{t("noteTitleLabel")}
								</Label>
								<Input
									id="add-instruction-note-title"
									value={noteTitle}
									aria-invalid={titleError ? true : undefined}
									aria-describedby={
										titleError
											? "add-instruction-note-title-hint add-instruction-note-title-error"
											: "add-instruction-note-title-hint"
									}
									onChange={(e) => {
										setNoteTitle(e.target.value);
										if (
											serverNoteRefusal?.field === "title"
										) {
											setServerNoteRefusal(null);
										}
									}}
								/>
								<p
									id="add-instruction-note-title-hint"
									className="text-muted-foreground text-xs"
								>
									{t("noteTitleHint")}
								</p>
								{titleError ? (
									<p
										id="add-instruction-note-title-error"
										className="text-destructive text-sm"
									>
										{titleError}
									</p>
								) : null}
							</div>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="add-instruction-note-body">
									{t("noteBodyLabel")}
								</Label>
								<Textarea
									id="add-instruction-note-body"
									value={noteBody}
									rows={3}
									aria-invalid={bodyError ? true : undefined}
									aria-describedby={
										bodyError
											? "add-instruction-note-body-hint add-instruction-note-body-error"
											: "add-instruction-note-body-hint"
									}
									onChange={(e) => {
										setNoteBody(e.target.value);
										if (
											serverNoteRefusal?.field === "body"
										) {
											setServerNoteRefusal(null);
										}
									}}
								/>
								<p
									id="add-instruction-note-body-hint"
									className="text-muted-foreground text-xs"
								>
									{t("noteBodyHint")}
								</p>
								{bodyError ? (
									<p
										id="add-instruction-note-body-error"
										className="text-destructive text-sm"
									>
										{bodyError}
									</p>
								) : null}
							</div>
							{!proposalOnly ? (
								<p className="text-muted-foreground text-xs">
									{t("noteProposalOnly")}
								</p>
							) : null}
						</>
					) : null}
					{!proposalOnly && !commitMode ? (
						<label
							htmlFor="add-instruction-publish"
							className="flex items-center gap-2 text-muted-foreground text-sm"
						>
							<Checkbox
								id="add-instruction-publish"
								checked={publishOnReady}
								onCheckedChange={(v) =>
									setPublishOnReady(v === true)
								}
							/>
							{t("publishOnReady")}
						</label>
					) : null}
					{!proposalOnly && !commitMode && canPublishBeforeScan ? (
						<PublishBeforeScanOption
							idPrefix="add-instruction"
							publishOnReady={publishOnReady}
							checked={publishBeforeScan}
							onCheckedChange={setPublishBeforeScan}
							acknowledged={acknowledged}
							onAcknowledgedChange={setAcknowledged}
							disabled={add.isPending}
						/>
					) : null}
				</div>
				<DialogFooter className="sm:flex-wrap sm:gap-y-2">
					{pullRequestOpened ? (
						<Button
							onClick={() => {
								reset();
								onOpenChange(false);
							}}
						>
							{t("done")}
						</Button>
					) : (
						<>
							<Button
								variant="ghost"
								disabled={add.isPending || commit.busy}
								onClick={() => onOpenChange(false)}
							>
								{t("cancel")}
							</Button>
							{commitMode ? (
								<Button
									className={WRAPPING_BUTTON}
									disabled={
										!canSubmit ||
										tooLargeToCommit ||
										commitMessage.trim() === ""
									}
									onClick={async () => {
										if (!file) {
											return;
										}
										setReading(true);
										try {
											const content =
												await fileToBase64(file);
											commit.start({
												...(nativeBase
													? { nativeBase }
													: { baseSnapshotId }),
												message: commitMessage,
												changes: [
													{
														op: "put",
														path: path.trim(),
														content,
														encoding: "base64",
													},
												],
												suggest: () =>
													add.mutate({
														picked: file,
														proposal: true,
													}),
											});
										} finally {
											setReading(false);
										}
									}}
								>
									{t("commitButton", {
										ref: repositoryTarget?.ref ?? "",
									})}
								</Button>
							) : null}
							{!proposalOnly && !commitMode ? (
								<Button
									disabled={
										!canSubmit ||
										(fastPath && !acknowledged)
									}
									onClick={() => {
										if (file) {
											add.mutate({
												picked: file,
												proposal: false,
											});
										}
									}}
								>
									{t("addButton")}
								</Button>
							) : null}
							{offersProposal ? (
								<Button
									className={WRAPPING_BUTTON}
									variant={
										proposalOnly ? "default" : "outline"
									}
									disabled={!canSubmitProposal}
									onClick={() => {
										if (file) {
											add.mutate({
												picked: file,
												proposal: true,
											});
										}
									}}
								>
									{t(
										repositoryTarget
											? "submitPullRequestButton"
											: "submitProposalButton",
									)}
								</Button>
							) : null}
						</>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
