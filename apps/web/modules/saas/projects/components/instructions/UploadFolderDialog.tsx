"use client";

import { SNAPSHOT_LIMITS } from "@repo/instructions";
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
import { FileIcon, FolderIcon, UploadIcon, XIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import {
	type FolderEntry,
	FolderPathCollisionError,
	type PickedSource,
	readFolderFiles,
} from "../../lib/read-folder";
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
	const folderInputRef = useRef<HTMLInputElement>(null);
	const filesInputRef = useRef<HTMLInputElement>(null);
	const nextSourceId = useRef(0);
	// Bumped by every recomputation and by every reset. A recomputation
	// only commits if the counter still holds the value it started with, so
	// closing the dialog while a pick is still hashing discards that pick
	// instead of letting it land in a dialog the person already dismissed
	// (the component stays mounted while closed, so its state outlives it).
	const generation = useRef(0);
	// Everything the person has added, in the order they added it. Entries
	// are always recomputed from ALL of these together rather than appended
	// per source, because one source can change another's preview: a root
	// `.fabricignore` added later rewrites what every folder keeps.
	const [sources, setSources] = useState<PickedSource[]>([]);
	const [entries, setEntries] = useState<FolderEntry[] | null>(null);
	const [fabricIgnoreText, setFabricIgnoreText] = useState<string | null>(
		null,
	);
	// True while `readFolderFiles` is hashing. Adding, removing and toggling
	// all start from the committed `sources`, so a second change made
	// mid-read would be computed from a list missing the first one.
	const [reading, setReading] = useState(false);
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
	// Unlike the secret-name preview above, these DO block the upload: they
	// are the fixed `SNAPSHOT_LIMITS` numbers `begin-snapshot.ts` refuses on,
	// counted over the kept set only (excluded files are never sent, so they
	// never count). The preview runs against the project's loaded settings
	// (`settingsReady`), so this is the set the server counts too, and a pick
	// over the limit could only fail after the person has waited for `begin`.
	const tooManyFiles = kept.length > SNAPSHOT_LIMITS.maxFiles;
	const tooManyBytes = keptBytes > SNAPSHOT_LIMITS.maxTotalBytes;
	const editingLocked =
		reading || progress !== null || serverExcludedNotice !== null;

	function resetPicked() {
		generation.current += 1;
		// The recomputation this invalidates will not clear its own flag
		// (it no longer owns the dialog's state), so the reset does.
		setReading(false);
		setSources([]);
		setEntries(null);
		setFabricIgnoreText(null);
		setProgress(null);
		setError(null);
		setPendingSnapshotId(null);
		setServerExcludedNotice(null);
	}

	function close() {
		resetPicked();
		onOpenChange(false);
	}

	function newSourceId(): string {
		nextSourceId.current += 1;
		return `source-${nextSourceId.current}`;
	}

	/**
	 * Recomputes the preview for `next` and commits it only if it is a
	 * valid pick. A collision between two sources leaves every piece of state
	 * as it was — the refused add, removal or toggle simply does not happen —
	 * and says which path collided so the person knows what to change.
	 */
	async function applySources(next: PickedSource[]) {
		if (next.length === 0) {
			resetPicked();
			return;
		}
		generation.current += 1;
		const current = generation.current;
		setReading(true);
		try {
			const result = await readFolderFiles(next, projectGlobs);
			if (current !== generation.current) {
				return;
			}
			setSources(next);
			setEntries(result.entries);
			setFabricIgnoreText(result.fabricIgnoreText);
			setError(null);
			// A changed pick starts a fresh upload, not a retry of whatever
			// came before it: the snapshot a failed attempt registered was
			// built from a different file list.
			setPendingSnapshotId(null);
		} catch (e) {
			if (current !== generation.current) {
				return;
			}
			setError(describeReadError(e));
		} finally {
			// Only the operation that still owns the dialog may end the read:
			// a stale one clearing the flag would unlock the controls in the
			// middle of whatever superseded it.
			if (current === generation.current) {
				setReading(false);
			}
		}
	}

	function describeReadError(e: unknown): string {
		if (e instanceof FolderPathCollisionError) {
			if (e.kind === "file-directory" && e.conflictsWith) {
				// The shorter of the two is the name used both ways
				// (`docs` for `docs` + `docs/a.md`), whichever order they
				// were added in.
				const [name, inside] =
					e.conflictsWith.length <= e.path.length
						? [e.conflictsWith, e.path]
						: [e.path, e.conflictsWith];
				return t("pathFileDirectoryConflict", { name, inside });
			}
			return t("pathCollision", { path: e.path });
		}
		return e instanceof Error ? e.message : t("genericError");
	}

	/**
	 * Reads the picked files, then clears the input so picking the SAME
	 * folder again (after removing it, say) still fires `change`.
	 */
	function takeFiles(e: ChangeEvent<HTMLInputElement>): File[] {
		const files = Array.from(e.target.files ?? []);
		e.target.value = "";
		return files;
	}

	async function addFolder(files: File[]) {
		if (files.length === 0) {
			return;
		}
		const first = files[0] as File & { webkitRelativePath?: string };
		const name = first.webkitRelativePath?.split("/")[0] || "folder";
		if (sources.some((s) => s.kind === "folder" && s.name === name)) {
			setError(t("duplicateFolder", { name }));
			return;
		}
		await applySources([
			...sources,
			{
				id: newSourceId(),
				kind: "folder",
				name,
				files,
				// A dot-folder (`.claude`, `.cursor`) only means anything under
				// its own name, and a second folder merged into the first's
				// root is rarely what anyone wants — both keep the name unless
				// the person unticks it.
				keepName: name.startsWith(".") || sources.length > 0,
			},
		]);
	}

	async function addFiles(files: File[]) {
		if (files.length === 0) {
			return;
		}
		const existing = sources.find((s) => s.kind === "files");
		if (!existing) {
			await applySources([
				...sources,
				{ id: newSourceId(), kind: "files", files },
			]);
			return;
		}
		// One root-files source, not one per pick, so the strip shows a single
		// "N files" chip. Picking a file with a name that is already there
		// replaces it: that is a re-pick of the same root file, and keeping
		// both would put two rows at one path.
		const incoming = new Set(files.map((f) => f.name));
		await applySources(
			sources.map((s) =>
				s.id === existing.id
					? {
							...s,
							files: [
								...s.files.filter((f) => !incoming.has(f.name)),
								...files,
							],
						}
					: s,
			),
		);
	}

	async function removeSource(id: string) {
		await applySources(sources.filter((s) => s.id !== id));
	}

	async function toggleKeepName(id: string) {
		await applySources(
			sources.map((s) =>
				s.id === id && s.kind === "folder"
					? { ...s, keepName: !s.keepName }
					: s,
			),
		);
	}

	function sourceLabel(source: PickedSource): string {
		return source.kind === "folder"
			? source.name
			: t("filesSource", { count: source.files.length });
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
							? t("reviewDescription")
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
					ref={folderInputRef}
					type="file"
					className="sr-only"
					aria-label={t("chooseFolder")}
					// Disabled with the visible buttons, and out of the tab
					// order: otherwise a keyboard or assistive-technology user
					// can reach the input directly and pick while settings are
					// loading, a read is hashing, or an upload is running.
					disabled={!settingsReady || editingLocked}
					tabIndex={-1}
					onChange={(e) => addFolder(takeFiles(e))}
					{...({ webkitdirectory: "", directory: "" } as Record<
						string,
						string
					>)}
					multiple
				/>
				<input
					ref={filesInputRef}
					type="file"
					className="sr-only"
					aria-label={t("chooseFiles")}
					disabled={!settingsReady || editingLocked}
					tabIndex={-1}
					onChange={(e) => addFiles(takeFiles(e))}
					multiple
				/>
				{!entries ? (
					<div className="flex flex-col items-start gap-2">
						<div className="flex flex-wrap gap-2">
							<Button
								onClick={() => folderInputRef.current?.click()}
								disabled={!settingsReady || reading}
							>
								<FolderIcon
									className="size-4"
									aria-hidden="true"
								/>
								{t("chooseFolder")}
							</Button>
							<Button
								variant="outline"
								onClick={() => filesInputRef.current?.click()}
								disabled={!settingsReady || reading}
							>
								<FileIcon
									className="size-4"
									aria-hidden="true"
								/>
								{t("chooseFiles")}
							</Button>
						</div>
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
						{error ? (
							<p className="text-destructive text-sm">{error}</p>
						) : null}
					</div>
				) : (
					<>
						<div className="flex flex-col gap-2">
							<ul
								aria-label={t("sourcesLabel")}
								className="flex flex-wrap gap-2"
							>
								{sources.map((source) => (
									<li
										key={source.id}
										className="flex items-center gap-2 rounded-md border border-border bg-muted/40 py-1 pr-1 pl-2 text-xs"
									>
										{source.kind === "folder" ? (
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
										<span className="font-mono">
											{sourceLabel(source)}
										</span>
										{source.kind === "folder" ? (
											<label
												htmlFor={`keep-name-${source.id}`}
												className="flex items-center gap-1 text-muted-foreground"
											>
												<Checkbox
													id={`keep-name-${source.id}`}
													checked={source.keepName}
													disabled={editingLocked}
													onCheckedChange={() =>
														toggleKeepName(
															source.id,
														)
													}
												/>
												{t("keepFolderName", {
													name: source.name,
												})}
											</label>
										) : null}
										<Button
											variant="ghost"
											size="icon-sm"
											className="size-6"
											aria-label={t("removeSource", {
												name: sourceLabel(source),
											})}
											disabled={editingLocked}
											onClick={() =>
												removeSource(source.id)
											}
										>
											<XIcon
												className="size-3.5"
												aria-hidden="true"
											/>
										</Button>
									</li>
								))}
							</ul>
							<div className="flex flex-wrap gap-2">
								<Button
									variant="outline"
									size="sm"
									disabled={editingLocked}
									onClick={() =>
										folderInputRef.current?.click()
									}
								>
									<FolderIcon
										className="size-3.5"
										aria-hidden="true"
									/>
									{t("addFolder")}
								</Button>
								<Button
									variant="outline"
									size="sm"
									disabled={editingLocked}
									onClick={() =>
										filesInputRef.current?.click()
									}
								>
									<FileIcon
										className="size-3.5"
										aria-hidden="true"
									/>
									{t("addFiles")}
								</Button>
							</div>
						</div>
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
					</>
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
				{tooManyFiles || tooManyBytes ? (
					<div
						role="alert"
						className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-destructive text-sm"
					>
						{tooManyFiles
							? t("tooManyFiles", {
									count: kept.length,
									max: SNAPSHOT_LIMITS.maxFiles,
								})
							: t("tooManyBytes", {
									size: formatBytes(keptBytes),
									max: formatBytes(
										SNAPSHOT_LIMITS.maxTotalBytes,
									),
								})}
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
										kept.length === 0 ||
										progress !== null ||
										reading ||
										tooManyFiles ||
										tooManyBytes
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
