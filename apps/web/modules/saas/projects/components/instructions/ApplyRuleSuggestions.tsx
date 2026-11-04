"use client";

/**
 * "Apply suggestions" under the AI rules review: the review turned into
 * concrete file edits (`suggestRuleEdits`, which writes nothing), shown one
 * file at a time with a checkbox and a before/after diff, and the checked ones
 * submitted together through the change path the editor uses for this viewer
 * (`ruleEditRoute`): a commit to the synced branch, a pull request
 * suggestion, or a new published version. Nothing reaches the published
 * instructions except through that path, so its validation, secret scan,
 * permissions, proposals and audit all apply.
 *
 * The dialog tells the review's story: the same counts line as the panel,
 * every file the review flagged (each with its category badges), either with
 * its edit or under "Not changed" with the reason, so nothing disappears.
 * While a commit runs only the submit button shows it; once it lands the
 * dialog closes and the panel shows the result (`onApplied`); a failure stays
 * here.
 */

import {
	type RuleFinding,
	ruleFindingCategoriesByFile,
	summarizeRuleFindings,
} from "@repo/instructions/rule-findings";
import { useDirectCommit } from "@saas/projects/hooks/use-direct-commit";
import { useInstructionActionError } from "@saas/projects/hooks/use-instruction-action-error";
import { editInstructionSnapshot } from "@saas/projects/lib/edit-snapshot";
import {
	defaultRuleSuggestionsMessage,
	type RuleEditSkip,
	type RuleEditSuggestion,
	ruleEditChangeBase,
	ruleEditRoute,
	ruleEditSkipReason,
	toCommitChanges,
	toInstructionEdits,
} from "@saas/projects/lib/rule-suggestions";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
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
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { Loader2Icon, WandSparklesIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { CommitMessageField } from "./CommitMessageField";
import { InstructionDiffBody } from "./InstructionDiffBody";
import { RuleCategoryBadges, RuleReviewSummary } from "./RuleReview";
import type { AppliedRuleSuggestions } from "./RuleSuggestionsResult";

export function ApplyRuleSuggestions({
	projectId,
	findings,
	canEdit,
	readOnlyMode,
	onApplied,
}: {
	projectId: string;
	/** The review on screen, so the edits address the same findings. */
	findings: RuleFinding[];
	/** A commit landed or became a pull request: the panel says so. */
	onApplied: (result: AppliedRuleSuggestions) => void;
	/** INSTRUCTION_CREATE, a UI gate: `suggestRuleEdits` and every change path re-check it. */
	canEdit: boolean;
	readOnlyMode: boolean;
}) {
	const id = useId();
	const queryClient = useQueryClient();
	const actionError = useInstructionActionError();
	const tFileView = useTranslations("projects.codingInstructions.fileView");
	const tDirect = useTranslations("projects.codingInstructions.direct");
	const repository = useQuery({
		...orpc.projects.instructions.repository.getState.queryOptions({
			input: { projectId },
		}),
		enabled: canEdit,
	});
	const settings = useQuery({
		...orpc.projects.instructions.getSettings.queryOptions({
			input: { projectId },
		}),
		enabled: canEdit,
	});
	const sync = useQuery({
		...orpc.projects.instructions.repositorySync.get.queryOptions({
			input: { projectId },
		}),
		enabled: canEdit,
	});
	const state = repository.data as
		| { availability: string; ref?: string }
		| undefined;
	const syncState = sync.data as
		| { configured?: { ref?: string } | null; migration?: unknown }
		| undefined;
	const route = ruleEditRoute({
		canEdit,
		readOnlyMode,
		availability: syncState?.migration ? "MIGRATING" : state?.availability,
		directRef: state?.ref ?? null,
		sourceOfTruth: (settings.data as { sourceOfTruth?: string } | undefined)
			?.sourceOfTruth,
		configuredRef: syncState?.configured?.ref ?? null,
	});

	const [open, setOpen] = useState(false);
	const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
	const [message, setMessage] = useState("");
	const suggest = useMutation(
		orpc.projects.instructions.suggestRuleEdits.mutationOptions(),
	);
	const edits = (suggest.data?.edits ?? []) as RuleEditSuggestion[];
	const skips = (suggest.data?.skipped ?? []) as RuleEditSkip[];
	const base = ruleEditChangeBase(suggest.data?.base);
	const chosen = edits.filter((edit) => selected.has(edit.path));
	const summary = useMemo(() => summarizeRuleFindings(findings), [findings]);
	// Every flagged file in the review's order, with its edit or the reason
	// it has none; then any edit of a file the review did not name.
	const rows = useMemo(() => {
		const editOf = new Map(edits.map((edit) => [edit.path, edit]));
		const skipOf = new Map(skips.map((skip) => [skip.path, skip]));
		const flagged = summary.files.map((path) => ({
			path,
			edit: editOf.get(path) ?? null,
			skip: skipOf.get(path) ?? null,
		}));
		const listed = new Set(summary.files);
		const extra = edits
			.filter((edit) => !listed.has(edit.path))
			.map((edit) => ({ path: edit.path, edit, skip: null }));
		return [...flagged, ...extra];
	}, [edits, skips, summary.files]);
	const notChanged = rows.filter((row) => row.edit === null).length;
	const leftOut = skips.filter(
		(skip) => !summary.files.includes(skip.path),
	).length;
	const categoriesOf = useMemo(
		() => ruleFindingCategoriesByFile(findings),
		[findings],
	);
	/** How many files the running commit carries, for the result line. */
	const committing = useRef(0);

	const close = () => {
		setOpen(false);
		suggest.reset();
		save.reset();
	};
	const reread = () =>
		queryClient.invalidateQueries({
			queryKey: orpc.projects.instructions.key(),
		});

	const commit = useDirectCommit({
		projectId,
		branch: route.kind === "commit" ? route.ref : "",
		onChanged: reread,
		quiet: true,
		onFinished: (result, { snapshotId }) => {
			close();
			if (result.kind === "committed") {
				onApplied({
					kind: "committed",
					sha: result.sha,
					files: committing.current,
					direct: state?.availability === "READY",
				});
			} else if (result.kind === "pull-request") {
				onApplied({
					kind: "pull-request",
					snapshotId,
					files: committing.current,
				});
			}
		},
	});

	const save = useMutation({
		mutationFn: (input: { edits: RuleEditSuggestion[] }) => {
			if (
				!base ||
				(route.kind !== "version" && route.kind !== "suggest")
			) {
				return Promise.reject(
					new Error("Instruction source unavailable"),
				);
			}
			const proposal = route.kind === "suggest";
			return editInstructionSnapshot({
				projectId,
				...base,
				publishOnReady: !proposal,
				proposal,
				edits: toInstructionEdits(input.edits),
				...(proposal && message.trim()
					? { message: message.trim() }
					: {}),
			});
		},
		onSuccess: () => {
			toast.success(
				route.kind === "suggest"
					? base?.nativeBase
						? tDirect("suggestionSubmitted")
						: tFileView("suggestionSubmitted")
					: tFileView("saved"),
			);
			close();
			void reread();
		},
	});

	const busy = save.isPending || commit.busy;

	function start() {
		setOpen(true);
		suggest.mutate(
			{ projectId, findings },
			{
				onSuccess: (result) => {
					setSelected(new Set(result.edits.map((edit) => edit.path)));
					setMessage(
						defaultRuleSuggestionsMessage(result.edits.length),
					);
				},
			},
		);
	}

	function submit() {
		if (chosen.length === 0 || !base) {
			return;
		}
		if (route.kind === "commit") {
			committing.current = chosen.length;
			commit.start({
				...base,
				message,
				changes: toCommitChanges(chosen),
			});
			return;
		}
		save.mutate({ edits: chosen });
	}

	function toggle(path: string, on: boolean) {
		setSelected((current) => {
			const next = new Set(current);
			if (on) {
				next.add(path);
			} else {
				next.delete(path);
			}
			return next;
		});
	}

	const submitLabel =
		route.kind === "commit"
			? `Commit to ${route.ref}`
			: route.kind === "suggest"
				? "Submit suggestion"
				: "Save & publish";

	const trigger =
		route.kind === "unavailable" ? (
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						type="button"
						size="sm"
						variant="outline"
						aria-disabled
						className="self-start opacity-50"
						onClick={() => toast.info(route.reason)}
					>
						<WandSparklesIcon
							className="size-4"
							aria-hidden="true"
						/>
						Apply suggestions
					</Button>
				</TooltipTrigger>
				<TooltipContent>{route.reason}</TooltipContent>
			</Tooltip>
		) : (
			<Button
				type="button"
				size="sm"
				variant="outline"
				className="self-start"
				disabled={suggest.isPending || busy}
				onClick={start}
			>
				<WandSparklesIcon className="size-4" aria-hidden="true" />
				Apply suggestions
			</Button>
		);

	return (
		<>
			{trigger}
			{/* The wait and the branch-moved dialog only: no pill (quiet). */}
			{commit.status}
			<Dialog
				open={open}
				onOpenChange={(next) => {
					if (!next && !busy) {
						close();
					}
				}}
			>
				<DialogContent className="max-h-[90vh] max-w-3xl grid-cols-[minmax(0,1fr)] overflow-y-auto">
					<DialogHeader>
						<DialogTitle>
							Apply the review's suggestions
						</DialogTitle>
						<DialogDescription>
							Check the edits to keep. They are submitted together
							as one change, checked and secret-scanned like any
							other edit.
						</DialogDescription>
						<RuleReviewSummary summary={summary} />
						{suggest.isSuccess ? (
							<p className="text-muted-foreground text-xs">
								{edits.length}{" "}
								{edits.length === 1 ? "edit" : "edits"}
								{notChanged > 0
									? ` · ${notChanged} not changed`
									: ""}
							</p>
						) : null}
					</DialogHeader>
					{suggest.isPending ? (
						<p className="flex items-center gap-2 text-muted-foreground text-sm">
							<Loader2Icon
								className="size-4 motion-safe:animate-spin"
								aria-hidden="true"
							/>
							Preparing the edits…
						</p>
					) : null}
					{suggest.error ? (
						<p role="alert" className="text-destructive text-sm">
							{actionError(suggest.error)}
						</p>
					) : null}
					{suggest.isSuccess && rows.length === 0 ? (
						<p className="text-muted-foreground text-sm">
							The review has no edits to suggest.
						</p>
					) : null}
					{suggest.isSuccess && rows.length > 0 ? (
						<ul
							className="flex flex-col gap-3"
							aria-label="Suggested edits"
						>
							{rows.map((row, index) => {
								const checkboxId = `${id}-edit-${index}`;
								const edit = row.edit;
								const categories = edit
									? edit.categories
									: (row.skip?.categories ??
										categoriesOf.get(row.path) ??
										[]);
								if (edit === null) {
									return (
										<li
											key={row.path}
											data-testid="rule-edit-not-changed"
											className="flex flex-col gap-1 rounded-md border border-dashed p-3"
										>
											<span className="flex flex-wrap items-center gap-2 text-sm">
												<code className="break-all">
													{row.path}
												</code>
												<RuleCategoryBadges
													categories={categories}
												/>
											</span>
											<p className="text-muted-foreground text-xs">
												Not changed:{" "}
												{ruleEditSkipReason(
													row.skip?.why ??
														"not-changed",
												)}
											</p>
										</li>
									);
								}
								return (
									<li
										key={row.path}
										className="flex min-w-0 flex-col gap-2 rounded-md border p-3"
									>
										<div className="flex items-start gap-2">
											<Checkbox
												id={checkboxId}
												checked={selected.has(
													edit.path,
												)}
												disabled={busy}
												onCheckedChange={(value) =>
													toggle(
														edit.path,
														value === true,
													)
												}
											/>
											<div className="flex min-w-0 flex-col gap-1">
												<label
													htmlFor={checkboxId}
													className="flex flex-wrap items-center gap-2 text-sm"
												>
													<code className="break-all">
														{edit.path}
													</code>
													<Badge
														status={
															edit.action ===
															"delete"
																? "error"
																: "info"
														}
													>
														{edit.action ===
														"delete"
															? "delete"
															: "update"}
													</Badge>
												</label>
												<RuleCategoryBadges
													categories={categories}
												/>
												<p className="text-muted-foreground text-xs">
													{edit.reason}
												</p>
											</div>
										</div>
										<InstructionDiffBody
											path={edit.path}
											before={edit.before}
											after={edit.after}
											truncated={false}
											wrap
										/>
									</li>
								);
							})}
						</ul>
					) : null}
					{leftOut > 0 ? (
						<p className="text-muted-foreground text-xs">
							{leftOut === 1
								? "1 other suggested edit was left out: it named a file the review did not flag, or failed the checks."
								: `${leftOut} other suggested edits were left out: they named files the review did not flag, or failed the checks.`}
						</p>
					) : null}
					{edits.length > 0 && route.kind !== "version" ? (
						<CommitMessageField
							value={message}
							refusal={
								route.kind === "commit"
									? commit.messageRefusal
									: null
							}
							disabled={busy}
							onChange={(next) => {
								commit.clearMessageRefusal();
								setMessage(next);
							}}
						/>
					) : null}
					{commit.error || save.error ? (
						<p role="alert" className="text-destructive text-sm">
							{commit.error ??
								(save.error ? actionError(save.error) : null)}
						</p>
					) : null}
					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							disabled={busy}
							onClick={close}
						>
							Cancel
						</Button>
						<Button
							type="button"
							aria-busy={busy || undefined}
							disabled={
								busy ||
								chosen.length === 0 ||
								!base ||
								route.kind === "unavailable" ||
								(route.kind === "commit" &&
									message.trim() === "")
							}
							onClick={submit}
						>
							{busy ? (
								<Loader2Icon
									className="size-4 motion-safe:animate-spin"
									aria-hidden="true"
								/>
							) : null}
							{submitLabel}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
