"use client";

import {
	FABRIC_IGNORE_FILE,
	isSecretFileName,
	SNAPSHOT_LIMITS,
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
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { toast } from "sonner";

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
 */
export function AddInstructionFileDialog({
	projectId,
	baseSnapshotId,
	open,
	onOpenChange,
	folder,
	onAdded,
}: {
	projectId: string;
	/** The published snapshot the new version is derived from. */
	baseSnapshotId: string;
	open: boolean;
	onOpenChange: (o: boolean) => void;
	/** The folder currently selected in the tree, if any. */
	folder: string | null;
	onAdded: () => void;
}) {
	const t = useTranslations("projects.codingInstructions.addFileDialog");
	const inputRef = useRef<HTMLInputElement>(null);
	const [file, setFile] = useState<File | null>(null);
	const [path, setPath] = useState("");
	const [publishOnReady, setPublishOnReady] = useState(true);

	function reset() {
		setFile(null);
		setPath("");
		setPublishOnReady(true);
		if (inputRef.current) {
			inputRef.current.value = "";
		}
	}

	const add = useMutation({
		mutationFn: (picked: File) =>
			editInstructionSnapshot({
				projectId,
				baseSnapshotId,
				publishOnReady,
				edits: [{ op: "put", path: path.trim(), body: picked }],
			}),
		onSuccess: () => {
			toast.success(t("added"));
			reset();
			onOpenChange(false);
			onAdded();
		},
		onError: (error: Error) => toast.error(error.message),
	});

	const tooLarge = file !== null && file.size > SNAPSHOT_LIMITS.maxFileBytes;
	const refusal = path.trim().length > 0 ? pathRefusal(path.trim(), t) : null;
	const canSubmit =
		file !== null &&
		path.trim().length > 0 &&
		!tooLarge &&
		refusal === null &&
		!add.isPending;

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
					<DialogTitle>{t("title")}</DialogTitle>
					<DialogDescription>{t("description")}</DialogDescription>
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
				</div>
				<DialogFooter>
					<Button
						variant="ghost"
						disabled={add.isPending}
						onClick={() => onOpenChange(false)}
					>
						{t("cancel")}
					</Button>
					<Button
						disabled={!canSubmit}
						onClick={() => {
							if (file) {
								add.mutate(file);
							}
						}}
					>
						{t("addButton")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
