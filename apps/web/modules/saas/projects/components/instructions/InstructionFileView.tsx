"use client";

import {
	FABRIC_IGNORE_FILE,
	parseFrontmatter,
	SNAPSHOT_LIMITS,
} from "@repo/instructions";
import {
	editInstructionSnapshot,
	type InstructionEdit,
} from "@saas/projects/lib/edit-snapshot";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Markdown } from "@ui/components/markdown";
import { Skeleton } from "@ui/components/skeleton";
import { Textarea } from "@ui/components/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { useTranslations } from "next-intl";
import { Fragment, useMemo, useState } from "react";
import { toast } from "sonner";

// Script/settings/other files render as plain preformatted text — no
// Markdown or frontmatter parsing, since they are not Markdown documents.
const PLAIN_KINDS = new Set(["SCRIPT", "SETTINGS", "OTHER"]);

/**
 * Frontmatter keys the header already shows, as its heading, its
 * description, or a row of its own. Every other top-level key is shown as
 * written, so a Guild-shaped file's `owner`, `tags`, `status`, `since` and
 * `areas` (design 2026-09-23 §5.8) are readable in the tab.
 */
const HEADER_FIELD_KEYS = new Set([
	"name",
	"description",
	"argument-hint",
	"allowed-tools",
	"tools",
	"model",
	"paths",
	"disable-model-invocation",
]);

async function copyMcpCall(
	text: string,
	copied: string,
	failed: string,
): Promise<void> {
	try {
		if (!navigator.clipboard) {
			throw new Error("clipboard unavailable");
		}
		await navigator.clipboard.writeText(text);
		toast.success(copied);
	} catch {
		toast.error(failed);
	}
}

function invocationLabel(
	fields: Record<string, string>,
	t: (key: string) => string,
): string | null {
	if (fields["disable-model-invocation"] === "true") {
		return t("invocationDisabled");
	}
	if ("disable-model-invocation" in fields) {
		return t("invocationAllowed");
	}
	return null;
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
 *  - a binary file, which has no text to put in a textarea. Replacing it goes
 *    through "Add file" at the same path.
 *  - a file past `maxInlineTextBytes`, or one whose shown body was cut short
 *    (offset paging or the 200,000-character reader cap) — saving a
 *    truncated body would silently delete the rest of the file.
 *  - `.fabricignore`, because it decides what the version excludes and the
 *    validation gate binds it to the snapshot's frozen rules. The server
 *    refuses it too; this is the explanation, not the enforcement.
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
	t: (key: string) => string,
): string | null {
	if (file.path === FABRIC_IGNORE_FILE) {
		return t("editFabricignore");
	}
	if (file.body === null) {
		return t("editBinary");
	}
	if (file.truncated || file.size > SNAPSHOT_LIMITS.maxInlineTextBytes) {
		return t("editTooLarge");
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
	path,
	canEdit = false,
	canPropose = false,
	repositoryTarget = null,
	onChanged,
}: {
	projectId: string;
	snapshotId: string;
	path: string;
	/**
	 * Whether to offer Edit and Delete file. A UI gate only: every save goes
	 * through `derive`, which re-checks `INSTRUCTION_CREATE` and the project's
	 * source of truth server-side.
	 */
	canEdit?: boolean;
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
}) {
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
	} | null>(null);

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
		onError: (error: Error) => toast.error(error.message),
	});

	if (q.isLoading) {
		return <Skeleton className="h-64 w-full" />;
	}
	if (!q.data) {
		return <p className="text-muted-foreground">{t("couldNotLoad")}</p>;
	}
	const f = q.data;
	const extraFields = parsed
		? Object.entries(parsed.fields).filter(
				([key, value]) =>
					!HEADER_FIELD_KEYS.has(key) && value.length > 0,
			)
		: [];
	const showHeader = Boolean(
		f.name || f.description || extraFields.length > 0,
	);
	const draftForPath = draft?.path === f.path ? draft : null;
	// Saveable only while the version it was taken from is still the one this
	// view is showing.
	const editingText =
		draftForPath?.snapshotId === snapshotId ? draftForPath.text : null;
	// Same text, no longer saveable: the published version moved. Shown
	// read-only with an explanation, so nothing typed is lost and nothing
	// typed can be written against a base it was not read from.
	const staleText =
		draftForPath && draftForPath.snapshotId !== snapshotId
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
	const refusal = branchFilePending
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
				);

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
	return (
		<div className="flex h-full min-w-0 flex-col overflow-hidden rounded-lg border border-border">
			<div className="flex items-center justify-between border-border border-b bg-muted/40 px-4 py-3">
				<code className="min-w-0 truncate text-muted-foreground text-xs">
					{f.path}
				</code>
				<div className="flex items-center gap-2">
					<Badge variant="secondary">
						{kindLabels[f.kind] ?? kindLabels.OTHER}
					</Badge>
					{editorText === null && showFromBranch ? (
						<Badge variant="outline">{t("fromBranchLabel")}</Badge>
					) : null}
					<span className="text-muted-foreground text-xs">
						{Math.round(f.size / 1024)} KB
					</span>
					<Button
						size="sm"
						variant="ghost"
						onClick={() => {
							// Not returned: the shared Button keeps a spinner up
							// until a returned promise settles, and a clipboard
							// write can stay pending indefinitely (document not
							// focused, permission blocked), so the button spun
							// forever. Fire it, report the outcome, move on.
							void copyMcpCall(
								`fabric_get_project_instruction({ projectId: "${projectId}", path: "${f.path}" })`,
								t("copied"),
								t("copyFailed"),
							);
						}}
					>
						{t("copyMcpCall")}
					</Button>
					{(canEdit || canPropose) && editorText === null ? (
						<>
							{refusal ? (
								/* `aria-disabled`, not `disabled`: a disabled
								   button is not focusable, so the reason would
								   be mouse-only — and a tooltip is the whole
								   point of showing the action at all. Pressing
								   it says why instead of doing nothing. */
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											size="sm"
											variant="ghost"
											aria-disabled
											className="opacity-50"
											onClick={() => toast.info(refusal)}
										>
											{t("editButton")}
										</Button>
									</TooltipTrigger>
									<TooltipContent>{refusal}</TooltipContent>
								</Tooltip>
							) : (
								<Button
									size="sm"
									variant="ghost"
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
									{t("editButton")}
								</Button>
							)}
							<Button
								size="sm"
								variant="ghost"
								className="text-destructive"
								disabled={save.isPending}
								onClick={() => {
									const proposal = !canEdit;
									if (
										!window.confirm(
											t(
												proposal
													? repositoryTarget
														? "deleteSuggestionConfirm"
														: "deleteProposalConfirm"
													: "deleteConfirm",
												{
													path: f.path,
													...(repositoryTarget ?? {}),
												},
											),
										)
									) {
										return;
									}
									save.mutate({
										publishOnReady: !proposal,
										proposal,
										edits: [{ op: "delete", path: f.path }],
									});
								}}
							>
								{t("deleteButton")}
							</Button>
						</>
					) : null}
				</div>
			</div>
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
							{t("staleNotice")}
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
							{canPropose && !canEdit && repositoryTarget ? (
								<p className="text-muted-foreground text-sm">
									{t(
										"repositoryProposalNotice",
										repositoryTarget,
									)}
								</p>
							) : null}
							<div className="flex items-center gap-2">
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
								{canPropose ? (
									<Button
										size="sm"
										variant={
											canEdit ? "outline" : "default"
										}
										disabled={save.isPending}
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
									disabled={save.isPending}
									onClick={() => setDraft(null)}
								>
									{t("cancelButton")}
								</Button>
							</div>
						</div>
					)}
				</div>
			) : (
				<div className="flex min-w-0 flex-col gap-4 overflow-auto p-5 [overflow-wrap:anywhere]">
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
								<div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/40 p-4">
									{f.name ? (
										<h2 className="font-semibold text-base">
											{f.name}
										</h2>
									) : null}
									{f.description ? (
										<p>{f.description}</p>
									) : null}
									{parsed ? (
										<dl className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
											{parsed.fields["argument-hint"] ? (
												<>
													<dt className="text-muted-foreground">
														{t("argumentHint")}
													</dt>
													<dd>
														{
															parsed.fields[
																"argument-hint"
															]
														}
													</dd>
												</>
											) : null}
											{(parsed.fields["allowed-tools"] ??
											parsed.fields.tools) ? (
												<>
													<dt className="text-muted-foreground">
														{t("allowedTools")}
													</dt>
													<dd>
														{parsed.fields[
															"allowed-tools"
														] ??
															parsed.fields.tools}
													</dd>
												</>
											) : null}
											{parsed.fields.model ? (
												<>
													<dt className="text-muted-foreground">
														{t("model")}
													</dt>
													<dd>
														{parsed.fields.model}
													</dd>
												</>
											) : null}
											{parsed.fields.paths ? (
												<>
													<dt className="text-muted-foreground">
														{t("appliesTo")}
													</dt>
													<dd className="whitespace-pre-line font-mono text-xs">
														{parsed.fields.paths}
													</dd>
												</>
											) : null}
											{invocationLabel(
												parsed.fields,
												t,
											) ? (
												<>
													<dt className="text-muted-foreground">
														{t("modelInvocation")}
													</dt>
													<dd>
														{invocationLabel(
															parsed.fields,
															t,
														)}
													</dd>
												</>
											) : null}
											{extraFields.map(([key, value]) => (
												<Fragment key={key}>
													<dt className="text-muted-foreground">
														{key}
													</dt>
													<dd className="whitespace-pre-line">
														{value}
													</dd>
												</Fragment>
											))}
										</dl>
									) : null}
								</div>
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
			)}
		</div>
	);
}
