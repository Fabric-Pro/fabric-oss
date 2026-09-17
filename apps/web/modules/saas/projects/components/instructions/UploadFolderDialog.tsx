"use client";

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
import { FileIcon, FolderIcon, UploadIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { type FolderEntry, readFolderFiles } from "../../lib/read-folder";
import { uploadSnapshot } from "../../lib/upload-snapshot";

type Row = {
	path: string;
	isDir: boolean;
	count: number;
	bytes: number;
	excluded: FolderEntry["excluded"];
	/** Files under this row the server's name-based secret gate will reject. */
	rejects: number;
	depth: number;
};

/** Offending paths listed in full before the notice switches to a count. */
const MAX_LISTED_REJECTIONS = 10;

function formatBytes(n: number): string {
	if (n < 1024) {
		return `${n} B`;
	}
	if (n < 1024 * 1024) {
		return `${Math.round(n / 1024)} KB`;
	}
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const EXCLUDED_REASON_KEY: Record<string, string> = {
	fabricignore: "excludedFabricignore",
	always: "excludedAlways",
	project: "excludedProject",
};

/** Group entries into top-level folders and files; one nested level for agent config dirs. */
function buildRows(entries: FolderEntry[]): Row[] {
	const rows = new Map<string, Row>();
	for (const e of entries) {
		const segs = e.path.split("/");
		const key =
			segs.length === 1
				? e.path
				: segs[0]?.startsWith(".") && segs.length > 2
					? `${segs[0]}/${segs[1]}`
					: (segs[0] ?? e.path);
		const isDir = segs.length > 1;
		const row = rows.get(key) ?? {
			path: key,
			isDir,
			count: 0,
			bytes: 0,
			excluded: e.excluded,
			rejects: 0,
			depth: key.includes("/") ? 1 : 0,
		};
		row.count += 1;
		row.bytes += e.size;
		// An excluded file is never uploaded, so it can never be rejected;
		// only a file that would actually be sent counts here.
		if (e.secretRule && !e.excluded) {
			row.rejects += 1;
		}
		if (row.excluded && !e.excluded) {
			row.excluded = null; // a folder is "excluded" only if all of it is
		}
		rows.set(key, row);
	}
	return [...rows.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function UploadFolderDialog({
	projectId,
	open,
	onOpenChange,
	onUploaded,
	projectGlobs,
	settingsReady = true,
}: {
	projectId: string;
	open: boolean;
	onOpenChange: (o: boolean) => void;
	onUploaded: (snapshotId: string) => void;
	projectGlobs?: string[] | null;
	/**
	 * False while the project's coding-instructions settings (its saved
	 * `.fabricignore` globs) are still loading. `readFolderFiles` bakes
	 * `projectGlobs` into its exclusion preview at pick-time, so picking a
	 * folder before those settings resolve would preview against the
	 * built-in defaults instead of the project's real ignore rules —
	 * disable the picker until the caller reports settings are ready.
	 * Defaults to `true` so callers that don't have a settings query (e.g.
	 * this component's own test) keep picking immediately.
	 */
	settingsReady?: boolean;
}) {
	const t = useTranslations("projects.codingInstructions.uploadDialog");
	const inputRef = useRef<HTMLInputElement>(null);
	const [entries, setEntries] = useState<FolderEntry[] | null>(null);
	const [fabricIgnoreText, setFabricIgnoreText] = useState<string | null>(
		null,
	);
	const [folderName, setFolderName] = useState("");
	const [publishOnReady, setPublishOnReady] = useState(true);
	const [progress, setProgress] = useState<{
		done: number;
		total: number;
	} | null>(null);
	const [error, setError] = useState<string | null>(null);
	// Set once `uploadSnapshot` reports the registered snapshot id, so a
	// retry after a partial failure resumes the SAME snapshot instead of
	// registering (and abandoning) a new one on every attempt.
	const [pendingSnapshotId, setPendingSnapshotId] = useState<string | null>(
		null,
	);
	// Non-empty once a successful upload reports paths the server's live
	// settings excluded that the client's preview had counted as kept (see
	// `uploadSnapshot`'s `serverExcludedPaths`). Kept open with this notice
	// instead of auto-closing, so the discrepancy isn't silently lost.
	const [serverExcludedNotice, setServerExcludedNotice] = useState<
		string[] | null
	>(null);
	// Defaults to supported so server and initial client render agree (no
	// hydration mismatch); corrected after mount. jsdom (this dialog's own
	// test) has no `webkitdirectory` property, so the fallback notice below
	// always renders under test — no test asserts on its absence.
	const [folderPickerSupported, setFolderPickerSupported] = useState(true);

	useEffect(() => {
		setFolderPickerSupported(
			"webkitdirectory" in document.createElement("input"),
		);
	}, []);

	const rows = useMemo(() => (entries ? buildRows(entries) : []), [entries]);
	const kept = entries?.filter((e) => !e.excluded) ?? [];
	// Previewed, never enforced here: `verifyAndScanInstructionFiles` runs
	// the same matcher server-side and is the authority. Showing them lets
	// someone drop the files and re-pick instead of paying for a full upload
	// that the gate then rejects wholesale. The Upload button stays enabled
	// on purpose — a client-side match that the server would not make must
	// never be able to block a legitimate upload.
	const willBeRejected = kept.filter((e) => e.secretRule);
	const keptBytes = kept.reduce((n, e) => n + e.size, 0);
	const excludedCount = (entries?.length ?? 0) - kept.length;

	function resetPicked() {
		setEntries(null);
		setFabricIgnoreText(null);
		setFolderName("");
		setProgress(null);
		setError(null);
		setPendingSnapshotId(null);
		setServerExcludedNotice(null);
	}

	function close() {
		resetPicked();
		onOpenChange(false);
	}

	async function onPick(files: FileList | null) {
		if (!files || files.length === 0) {
			return;
		}
		const first = files[0] as File & { webkitRelativePath?: string };
		setFolderName(first.webkitRelativePath?.split("/")[0] ?? "folder");
		const result = await readFolderFiles(files, projectGlobs);
		setEntries(result.entries);
		setFabricIgnoreText(result.fabricIgnoreText);
		setError(null);
		// A fresh pick starts a fresh upload, not a retry of whatever came
		// before it.
		setPendingSnapshotId(null);
	}

	async function onUpload() {
		if (!entries) {
			return;
		}
		setError(null);
		setProgress({ done: 0, total: kept.length });
		try {
			const { snapshotId, serverExcludedPaths } = await uploadSnapshot({
				projectId,
				entries,
				fabricIgnoreText,
				publishOnReady,
				resumeSnapshotId: pendingSnapshotId ?? undefined,
				onSnapshotStarted: setPendingSnapshotId,
				onProgress: (done, total) => setProgress({ done, total }),
			});
			onUploaded(snapshotId);
			if (serverExcludedPaths.length > 0) {
				// Keep the dialog open on this one notice instead of
				// auto-closing: the upload succeeded, but not every file the
				// preview promised actually made it in.
				setProgress(null);
				setServerExcludedNotice(serverExcludedPaths);
			} else {
				close();
			}
		} catch (e) {
			// Surfaces the server's own message verbatim — a secret-scan
			// rejection or a validation failure (bad path, oversize file,
			// too many files) both throw with a human-readable message from
			// `begin-snapshot.ts`. `pendingSnapshotId` is deliberately left
			// set here: the snapshot stays RECEIVING server-side, and
			// clicking Upload again resumes it rather than abandoning it.
			setError(e instanceof Error ? e.message : t("genericError"));
			setProgress(null);
		}
	}

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => (next ? onOpenChange(next) : close())}
		>
			<DialogContent className="max-w-3xl">
				<DialogHeader>
					<DialogTitle>
						{entries ? t("reviewTitle") : t("pickTitle")}
					</DialogTitle>
					<DialogDescription>
						{entries
							? t.rich("reviewDescription", {
									folder: () => <code>{folderName}</code>,
								})
							: t("pickDescription")}
					</DialogDescription>
				</DialogHeader>
				{/*
				 * `sr-only` (off-screen but rendered), NOT `hidden`
				 * (display:none) — Chromium 124+ blocks the OS file picker
				 * for a programmatic `.click()` on a display:none input.
				 * Same pattern as AttachmentDropzone/WizardFileUploader.
				 */}
				<input
					ref={inputRef}
					type="file"
					className="sr-only"
					aria-label={t("chooseFolder")}
					onChange={(e) => onPick(e.target.files)}
					{...({ webkitdirectory: "", directory: "" } as Record<
						string,
						string
					>)}
					multiple
				/>
				{!entries ? (
					<div className="flex flex-col items-start gap-2">
						<Button
							onClick={() => inputRef.current?.click()}
							disabled={!settingsReady}
						>
							<FolderIcon className="size-4" aria-hidden="true" />
							{t("chooseFolder")}
						</Button>
						{settingsReady ? (
							folderPickerSupported ? null : (
								<p className="text-muted-foreground text-xs">
									{t("folderPickerUnsupported")}
								</p>
							)
						) : (
							<p className="text-muted-foreground text-xs">
								{t("settingsLoading")}
							</p>
						)}
					</div>
				) : (
					<div className="max-h-[400px] overflow-auto rounded-lg border border-border">
						<div className="grid grid-cols-[1fr_90px_80px] gap-3 border-border border-b bg-muted px-3 py-2 font-medium text-muted-foreground text-xs">
							<span>{t("pathColumn")}</span>
							<span className="text-right">
								{t("filesColumn")}
							</span>
							<span className="text-right">
								{t("sizeColumn")}
							</span>
						</div>
						{rows.map((r) => (
							<div
								key={r.path}
								className={`grid grid-cols-[1fr_90px_80px] items-center gap-3 border-border border-b px-3 py-1.5 ${r.excluded ? "text-muted-foreground" : ""}`}
								style={{
									paddingLeft: `${12 + r.depth * 20}px`,
								}}
							>
								<span className="flex items-center gap-2 font-mono text-xs">
									{r.isDir ? (
										<FolderIcon
											className="size-3.5"
											aria-hidden="true"
										/>
									) : (
										<FileIcon
											className="size-3.5"
											aria-hidden="true"
										/>
									)}
									{r.path}
									{r.excluded ? (
										<span className="ml-2 font-sans text-xs">
											{t(
												EXCLUDED_REASON_KEY[
													r.excluded.layer
												] ?? "excludedDefault",
											)}
										</span>
									) : null}
									{r.rejects > 0 ? (
										<span className="ml-2 font-sans text-destructive text-xs">
											{t("willBeRejected")}
										</span>
									) : null}
								</span>
								<span className="text-right text-xs">
									{r.isDir ? `${r.count} files` : ""}
								</span>
								<span className="text-right text-xs">
									{formatBytes(r.bytes)}
								</span>
							</div>
						))}
					</div>
				)}
				{willBeRejected.length > 0 ? (
					<div
						role="alert"
						className="flex flex-col gap-1 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm"
					>
						<p className="font-medium text-destructive">
							{t("rejectedFilesTitle", {
								count: willBeRejected.length,
							})}
						</p>
						<p className="text-muted-foreground">
							{t("rejectedFilesBody")}
						</p>
						<ul className="flex flex-col gap-0.5">
							{willBeRejected
								.slice(0, MAX_LISTED_REJECTIONS)
								.map((e) => (
									<li key={e.path}>
										<code className="text-xs">
											{e.path}
										</code>
									</li>
								))}
						</ul>
						{willBeRejected.length > MAX_LISTED_REJECTIONS ? (
							<p className="text-muted-foreground text-xs">
								{t("rejectedFilesMore", {
									count:
										willBeRejected.length -
										MAX_LISTED_REJECTIONS,
								})}
							</p>
						) : null}
					</div>
				) : null}
				{entries ? (
					<div className="flex flex-col gap-2">
						<p className="font-medium">
							{t("summary", {
								keptCount: kept.length,
								keptSize: formatBytes(keptBytes),
								excludedCount,
							})}
						</p>
						<label
							htmlFor="publish-on-ready"
							className="flex items-center gap-2 text-muted-foreground text-sm"
						>
							<Checkbox
								id="publish-on-ready"
								checked={publishOnReady}
								onCheckedChange={(v) =>
									setPublishOnReady(v === true)
								}
							/>
							{t("publishOnReady")}
						</label>
						{progress ? (
							<p aria-live="polite" className="text-sm">
								{t("progress", {
									done: progress.done,
									total: progress.total,
								})}
							</p>
						) : null}
						{error ? (
							<p className="text-destructive text-sm">{error}</p>
						) : null}
						{serverExcludedNotice ? (
							<p
								aria-live="polite"
								className="text-muted-foreground text-sm"
							>
								{t("serverExcludedNotice", {
									count: serverExcludedNotice.length,
								})}
							</p>
						) : null}
					</div>
				) : null}
				<DialogFooter>
					{serverExcludedNotice ? (
						<Button onClick={close}>{t("done")}</Button>
					) : (
						<>
							<Button
								variant="outline"
								onClick={close}
								disabled={progress !== null}
							>
								{t("cancel")}
							</Button>
							{entries ? (
								<Button
									onClick={onUpload}
									disabled={
										kept.length === 0 || progress !== null
									}
								>
									<UploadIcon
										className="size-4"
										aria-hidden="true"
									/>
									{t("uploadButton", { count: kept.length })}
								</Button>
							) : null}
						</>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
