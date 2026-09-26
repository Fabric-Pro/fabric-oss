"use client";

import {
	FABRIC_IGNORE_FILE,
	isSecretFileName,
	type ProposalNote,
	proposalNoteSchema,
	SNAPSHOT_LIMITS,
	validatePortableName,
	validateRelativePath,
} from "@repo/instructions";
import { editInstructionSnapshot } from "@saas/projects/lib/edit-snapshot";
import { useMutation } from "@tanstack/react-query";
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
import { PublishBeforeScanOption } from "./PublishBeforeScanOption";

/** The admission refusals the dialog names with its own copy (spec §5.3). */
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
 * The reason a path cannot be added, previewed client-side, or null.
 *
 * Every one of these is re-checked by `derive` on the server, which is the
 * authority. Checking here means a mistyped path is reported before a file is
 * read and a version is registered, rather than as a refused request.
 */
function pathRefusal(
	path: string,
	t: (key: string, values?: Record<string, string>) => string,
): string | null {
	const v = validateRelativePath(path);
	if (!v.ok) {
		return t("pathInvalid", { reason: v.reason });
	}
	if (v.path === FABRIC_IGNORE_FILE) {
		return t("pathFabricignore");
	}
	// This dialog only ever ADDS or REPLACES a file, so the portability rules
	// apply to every path it accepts. A delete goes through a different
	// control and is deliberately exempt, because a grandfathered name has to
	// stay removable.
	const portable = validatePortableName(v.path);
	if (!portable.ok) {
		return t("pathInvalid", { reason: portable.reason });
	}
	const secretRule = isSecretFileName(v.path);
	if (secretRule) {
		return t("pathSecret", { rule: secretRule });
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
	open,
	onOpenChange,
	folder,
	proposalOnly = false,
	canPropose = false,
	repositoryTarget = null,
	canPublishBeforeScan = false,
	onAdded,
}: {
	projectId: string;
	/** The published snapshot the new version is derived from. */
	baseSnapshotId: string;
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
	onAdded: () => void;
}) {
	const t = useTranslations("projects.codingInstructions.addFileDialog");
	const inputRef = useRef<HTMLInputElement>(null);
	const [file, setFile] = useState<File | null>(null);
	const [path, setPath] = useState("");
	const [publishOnReady, setPublishOnReady] = useState(true);
	const [publishBeforeScan, setPublishBeforeScan] = useState(false);
	const [acknowledged, setAcknowledged] = useState(false);
	const [noteTitle, setNoteTitle] = useState("");
	const [noteBody, setNoteBody] = useState("");
	// The server's NOTE_REJECTED, shown under the field it names until that
	// field is edited.
	const [serverNoteRefusal, setServerNoteRefusal] = useState<{
		field: NoteField;
		message: string;
	} | null>(null);
	const offersProposal = proposalOnly || canPropose;
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
		if (inputRef.current) {
			inputRef.current.value = "";
		}
	}

	const note = noteFrom(noteTitle, noteBody);
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
				baseSnapshotId,
				publishOnReady: proposal ? false : publishOnReady,
				proposal,
				// A direct version stores no note, so none is sent with one.
				...(proposal && note ? { note } : {}),
				...(!proposal && fastPath ? { publishBeforeScan: true } : {}),
				edits: [{ op: "put", path: path.trim(), body: picked }],
			}),
		onSuccess: (_result, input) => {
			toast.success(
				input.proposal
					? t(
							repositoryTarget
								? "pullRequestSubmitted"
								: "proposalSubmitted",
						)
					: t("added"),
			);
			reset();
			onOpenChange(false);
			onAdded();
		},
		onError: (error: Error) => {
			const data = refusalData(error);
			if (data?.reason === "NOTE_REJECTED") {
				setServerNoteRefusal({
					field: data.field === "body" ? "body" : "title",
					message: error.message,
				});
				return;
			}
			toast.error(
				data?.reason && ADMISSION_REFUSALS.has(data.reason)
					? t(`refusals.${data.reason}`)
					: error.message,
			);
		},
	});

	const tooLarge = file !== null && file.size > SNAPSHOT_LIMITS.maxFileBytes;
	const refusal = path.trim().length > 0 ? pathRefusal(path.trim(), t) : null;
	const noteField = offersProposal ? noteRefusalField(note) : null;
	const titleError =
		noteField === "title"
			? t("noteTitleInvalid")
			: serverNoteRefusal?.field === "title"
				? serverNoteRefusal.message
				: null;
	const bodyError =
		noteField === "body"
			? t("noteBodyInvalid")
			: serverNoteRefusal?.field === "body"
				? serverNoteRefusal.message
				: null;
	const canSubmit =
		file !== null &&
		path.trim().length > 0 &&
		!tooLarge &&
		refusal === null &&
		!add.isPending;
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
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						{repositoryTarget ? t("repositoryTitle") : t("title")}
					</DialogTitle>
					<DialogDescription>
						{repositoryTarget
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
					{!proposalOnly ? (
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
					{!proposalOnly && canPublishBeforeScan ? (
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
				<DialogFooter>
					<Button
						variant="ghost"
						disabled={add.isPending}
						onClick={() => onOpenChange(false)}
					>
						{t("cancel")}
					</Button>
					{!proposalOnly ? (
						<Button
							disabled={!canSubmit || (fastPath && !acknowledged)}
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
							variant={proposalOnly ? "default" : "outline"}
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
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
