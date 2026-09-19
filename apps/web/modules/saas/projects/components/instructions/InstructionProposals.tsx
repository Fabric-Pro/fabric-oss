"use client";

import { formatRelativeTime } from "@saas/shared/lib/format-time";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Skeleton } from "@ui/components/skeleton";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";

type ProposalStatus = "PENDING" | "APPROVED" | "REJECTED";
type ValidationStatus =
	| "RECEIVING"
	| "VALIDATING"
	| "READY"
	| "REJECTED"
	| "FAILED";

type ProposalRow = {
	id: string;
	version: number;
	baseVersion: number | null;
	status: ValidationStatus;
	proposalStatus: ProposalStatus;
	createdAt: string | Date;
	readyAt: string | Date | null;
	proposer: { id: string; name: string | null };
	reviewer: { id: string; name: string | null } | null;
	reviewedAt: string | Date | null;
	isStale: boolean;
	canCancel: boolean;
};

type ProposalChange = {
	path: string;
	op: "add" | "edit" | "delete";
	before: string | null;
	after: string | null;
	binary: boolean;
	beforeOmitted: OmissionReason;
	afterOmitted: OmissionReason;
	beforeSize: number | null;
	afterSize: number | null;
};

type OmissionReason = "BINARY" | "FILE_TOO_LARGE" | "RESPONSE_LIMIT" | null;

type ProposalDetail = ProposalRow & { changes: ProposalChange[] | null };
type ProposalFilePage = {
	path: string;
	side: "before" | "after";
	body: string;
	offset: number;
	nextOffset: number | null;
	truncated: boolean;
};

const VALIDATING = new Set<ValidationStatus>(["RECEIVING", "VALIDATING"]);
const PAGE_SIZE = 25;

function validationLabel(
	status: ValidationStatus,
	t: (key: string) => string,
): string {
	if (status === "RECEIVING" || status === "VALIDATING") {
		return t("checking");
	}
	if (status === "REJECTED") {
		return t("validationRejected");
	}
	if (status === "FAILED") {
		return t("validationFailed");
	}
	return t("ready");
}

function proposalLabel(
	status: ProposalStatus,
	t: (key: string) => string,
): string {
	if (status === "APPROVED") {
		return t("approved");
	}
	if (status === "REJECTED") {
		return t("rejected");
	}
	return t("pending");
}

/**
 * Proposal metadata for readers and validated, immutable diffs for reviewers.
 * The server limits a reader's list to their own rows, withholds file bytes
 * until the scan has completed, and alone decides whether the published base
 * is still current.
 */
export function InstructionProposals({
	projectId,
	open,
	onOpenChange,
	onChanged,
	canReview = true,
}: {
	projectId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onChanged: () => void;
	canReview?: boolean;
}) {
	const t = useTranslations("projects.codingInstructions.proposalReview");
	const queryClient = useQueryClient();
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [cursor, setCursor] = useState<string | undefined>();
	const [cursorHistory, setCursorHistory] = useState<
		Array<string | undefined>
	>([]);
	const [filePageInput, setFilePageInput] = useState<{
		path: string;
		side: "before" | "after";
		offset: number;
	} | null>(null);
	const proposals = useQuery({
		...orpc.projects.instructions.proposals.list.queryOptions({
			input: { projectId, limit: PAGE_SIZE, cursor },
		}),
		enabled: open,
		refetchInterval: (query) => {
			const rows = (
				query.state.data as { items?: ProposalRow[] } | undefined
			)?.items;
			return rows?.some(
				(row) =>
					row.proposalStatus === "PENDING" &&
					VALIDATING.has(row.status),
			)
				? 3_000
				: false;
		},
	});
	const detail = useQuery({
		...orpc.projects.instructions.proposals.get.queryOptions({
			input: { projectId, snapshotId: selectedId ?? "" },
		}),
		enabled: open && canReview && selectedId !== null,
		refetchInterval: (query) => {
			const row = query.state.data as ProposalDetail | undefined;
			return row?.proposalStatus === "PENDING" &&
				VALIDATING.has(row.status)
				? 3_000
				: false;
		},
	});
	const filePage = useQuery({
		...orpc.projects.instructions.proposals.file.queryOptions({
			input: {
				projectId,
				snapshotId: selectedId ?? "",
				path: filePageInput?.path ?? "",
				side: filePageInput?.side ?? "after",
				offset: filePageInput?.offset ?? 0,
			},
		}),
		enabled:
			open && canReview && selectedId !== null && filePageInput !== null,
	});
	const clearSelection = () => {
		setSelectedId(null);
		setFilePageInput(null);
	};
	const refreshState = () => {
		onChanged();
		void proposals.refetch();
		if (canReview && selectedId !== null) {
			void detail.refetch();
		}
		void queryClient.invalidateQueries({
			queryKey: orpc.projects.instructions.getPublished.queryOptions({
				input: { projectId },
			}).queryKey,
		});
	};
	const approve = useMutation(
		orpc.projects.instructions.proposals.approve.mutationOptions({
			onSuccess: () => {
				toast.success(t("approveSuccess"));
				refreshState();
			},
			onError: (error) => {
				toast.error(error.message);
				refreshState();
			},
		}),
	);
	const reject = useMutation(
		orpc.projects.instructions.proposals.reject.mutationOptions({
			onSuccess: () => {
				toast.success(t("rejectSuccess"));
				refreshState();
			},
			onError: (error) => {
				toast.error(error.message);
				refreshState();
			},
		}),
	);
	const cancel = useMutation(
		orpc.projects.instructions.proposals.cancel.mutationOptions({
			onSuccess: () => {
				toast.success(t("cancelSuccess"));
				refreshState();
			},
			onError: (error) => {
				toast.error(error.message);
				refreshState();
			},
		}),
	);
	const selected = detail.data as ProposalDetail | undefined;
	const deciding = approve.isPending || reject.isPending || cancel.isPending;
	const page = proposals.data as
		| { items: ProposalRow[]; nextCursor: string | null }
		| undefined;

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) {
					clearSelection();
					setCursor(undefined);
					setCursorHistory([]);
				}
				onOpenChange(next);
			}}
		>
			<DialogContent className="max-w-4xl">
				<DialogHeader>
					<DialogTitle>{t("title")}</DialogTitle>
					<DialogDescription>{t("description")}</DialogDescription>
				</DialogHeader>
				{proposals.isLoading ? (
					<Skeleton className="h-24 w-full" />
				) : null}
				{proposals.isError ? (
					<p role="alert" className="text-destructive text-sm">
						{t("listError")}
					</p>
				) : null}
				{proposals.isSuccess && page?.items.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						{t("empty")}
					</p>
				) : null}
				{proposals.isSuccess ? (
					<div className="flex max-h-44 flex-col gap-2 overflow-auto">
						{page?.items.map((proposal) => (
							<div
								key={proposal.id}
								className="flex items-stretch gap-2"
							>
								<Button
									variant={
										selectedId === proposal.id
											? "secondary"
											: "outline"
									}
									className="h-auto min-w-0 flex-1 justify-between whitespace-normal p-3 text-left"
									aria-label={t("proposalVersion", {
										version: proposal.version,
									})}
									disabled={!canReview}
									onClick={() => {
										setFilePageInput(null);
										setSelectedId(proposal.id);
									}}
								>
									<span className="flex flex-col gap-1">
										<span>
											{t("proposalVersion", {
												version: proposal.version,
											})}
										</span>
										<span className="text-muted-foreground text-xs">
											{t("submittedBy", {
												name:
													proposal.proposer.name ??
													t("anonymousUser"),
												time: formatRelativeTime(
													proposal.createdAt,
												),
											})}
										</span>
									</span>
									<span className="flex shrink-0 gap-1">
										<Badge variant="outline">
											{validationLabel(
												proposal.status,
												t,
											)}
										</Badge>
										<Badge
											variant={
												proposal.proposalStatus ===
												"PENDING"
													? "secondary"
													: proposal.proposalStatus ===
															"APPROVED"
														? "success"
														: "destructive"
											}
										>
											{proposalLabel(
												proposal.proposalStatus,
												t,
											)}
										</Badge>
									</span>
								</Button>
								{proposal.canCancel ? (
									<Button
										variant="outline"
										disabled={deciding}
										onClick={() => {
											if (
												window.confirm(
													t("cancelConfirm"),
												)
											) {
												cancel.mutate({
													projectId,
													snapshotId: proposal.id,
												});
											}
										}}
									>
										{t("cancel")}
									</Button>
								) : null}
							</div>
						))}
					</div>
				) : null}
				{proposals.isSuccess &&
				(cursorHistory.length > 0 || page?.nextCursor) ? (
					<div className="flex justify-end gap-2">
						<Button
							variant="outline"
							disabled={cursorHistory.length === 0}
							onClick={() => {
								clearSelection();
								const previous = [...cursorHistory];
								setCursor(previous.pop());
								setCursorHistory(previous);
							}}
						>
							{t("previousPage")}
						</Button>
						<Button
							variant="outline"
							disabled={!page?.nextCursor}
							onClick={() => {
								clearSelection();
								setCursorHistory((history) => [
									...history,
									cursor,
								]);
								setCursor(page?.nextCursor ?? undefined);
							}}
						>
							{t("nextPage")}
						</Button>
					</div>
				) : null}
				{selectedId !== null && detail.isLoading ? (
					<Skeleton className="h-48 w-full" />
				) : null}
				{selectedId !== null && detail.isError ? (
					<p role="alert" className="text-destructive text-sm">
						{t("detailError")}
					</p>
				) : null}
				{selected ? (
					<div className="flex max-h-[420px] flex-col gap-3 overflow-auto rounded-lg border border-border p-4">
						{selected.isStale ? (
							<p
								role="alert"
								className="text-destructive text-sm"
							>
								{t("stale")}
							</p>
						) : null}
						{VALIDATING.has(selected.status) ? (
							<p
								aria-live="polite"
								className="text-muted-foreground text-sm"
							>
								{t("checkingBody")}
							</p>
						) : null}
						{selected.status === "REJECTED" ? (
							<p
								role="alert"
								className="text-destructive text-sm"
							>
								{t("validationRejectedBody")}
							</p>
						) : null}
						{selected.status === "FAILED" ? (
							<p
								role="alert"
								className="text-destructive text-sm"
							>
								{t("validationFailedBody")}
							</p>
						) : null}
						{selected.status === "READY" && selected.changes ? (
							<div className="flex flex-col gap-3">
								{selected.changes.some(
									(change) =>
										change.beforeOmitted !== null ||
										change.afterOmitted !== null,
								) ? (
									<p
										role="alert"
										className="text-warning text-sm"
									>
										{t("diffIncomplete")}
									</p>
								) : null}
								{selected.changes.map((change) => (
									<section
										key={change.path}
										className="flex flex-col gap-2 rounded-md border border-border p-3"
									>
										<div className="flex items-center gap-2">
											<Badge variant="secondary">
												{t(change.op)}
											</Badge>
											<code className="min-w-0 truncate text-xs">
												{change.path}
											</code>
										</div>
										{change.binary ? (
											<p className="text-muted-foreground text-sm">
												{t("binary")}
											</p>
										) : (
											<div className="grid gap-2 md:grid-cols-2">
												{change.before !== null ? (
													<div>
														<p className="mb-1 text-muted-foreground text-xs">
															{t("before")}
														</p>
														<pre className="max-h-44 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 font-mono text-xs">
															{change.before}
														</pre>
													</div>
												) : null}
												{change.after !== null ? (
													<div>
														<p className="mb-1 text-muted-foreground text-xs">
															{t("after")}
														</p>
														<pre className="max-h-44 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 font-mono text-xs">
															{change.after}
														</pre>
													</div>
												) : null}
												{change.beforeOmitted &&
												change.beforeOmitted !==
													"BINARY" ? (
													<div>
														<p className="mb-1 text-muted-foreground text-xs">
															{t("before")}
														</p>
														<p className="text-muted-foreground text-sm">
															{t(
																change.beforeOmitted ===
																	"FILE_TOO_LARGE"
																	? "fileTooLarge"
																	: "responseLimit",
															)}
														</p>
														<Button
															variant="link"
															className="h-auto justify-start px-0"
															onClick={() =>
																setFilePageInput(
																	{
																		path: change.path,
																		side: "before",
																		offset: 0,
																	},
																)
															}
														>
															{t("viewFullSide")}
														</Button>
													</div>
												) : null}
												{change.afterOmitted &&
												change.afterOmitted !==
													"BINARY" ? (
													<div>
														<p className="mb-1 text-muted-foreground text-xs">
															{t("after")}
														</p>
														<p className="text-muted-foreground text-sm">
															{t(
																change.afterOmitted ===
																	"FILE_TOO_LARGE"
																	? "fileTooLarge"
																	: "responseLimit",
															)}
														</p>
														<Button
															variant="link"
															className="h-auto justify-start px-0"
															onClick={() =>
																setFilePageInput(
																	{
																		path: change.path,
																		side: "after",
																		offset: 0,
																	},
																)
															}
														>
															{t("viewFullSide")}
														</Button>
													</div>
												) : null}
											</div>
										)}
									</section>
								))}
								{filePageInput ? (
									<div className="rounded-md border border-border p-3">
										<p className="mb-2 text-muted-foreground text-xs">
											{t("fullSideTitle", {
												side: t(filePageInput.side),
												path: filePageInput.path,
											})}
										</p>
										{filePage.isLoading ? (
											<Skeleton className="h-24 w-full" />
										) : null}
										{filePage.isError ? (
											<p
												role="alert"
												className="text-destructive text-sm"
											>
												{t("filePageError")}
											</p>
										) : null}
										{filePage.data ? (
											<>
												<pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 font-mono text-xs">
													{
														(
															filePage.data as ProposalFilePage
														).body
													}
												</pre>
												<div className="mt-2 flex gap-2">
													<Button
														variant="outline"
														disabled={
															filePageInput.offset ===
															0
														}
														onClick={() =>
															setFilePageInput(
																(current) =>
																	current
																		? {
																				...current,
																				offset: Math.max(
																					0,
																					current.offset -
																						50_000,
																				),
																			}
																		: null,
															)
														}
													>
														{t("previousPage")}
													</Button>
													<Button
														variant="outline"
														disabled={
															(
																filePage.data as ProposalFilePage
															).nextOffset ===
															null
														}
														onClick={() => {
															const nextOffset = (
																filePage.data as ProposalFilePage
															).nextOffset;
															if (
																nextOffset !==
																null
															) {
																setFilePageInput(
																	(
																		current,
																	) =>
																		current
																			? {
																					...current,
																					offset: nextOffset,
																				}
																			: null,
																);
															}
														}}
													>
														{t("nextPage")}
													</Button>
												</div>
											</>
										) : null}
									</div>
								) : null}
							</div>
						) : null}
						{selected.proposalStatus === "APPROVED" ? (
							<p className="text-success text-sm">
								{t("approvedBody")}
							</p>
						) : null}
						{selected.proposalStatus === "REJECTED" ? (
							<p className="text-muted-foreground text-sm">
								{t("rejectedBody")}
							</p>
						) : null}
						{selected.proposalStatus === "PENDING" &&
						!VALIDATING.has(selected.status) ? (
							<div className="flex gap-2">
								{selected.status === "READY" &&
								!selected.isStale ? (
									<Button
										disabled={deciding}
										onClick={() =>
											approve.mutate({
												projectId,
												snapshotId: selected.id,
											})
										}
									>
										{t("approve")}
									</Button>
								) : null}
								<Button
									variant="outline"
									disabled={deciding}
									onClick={() => {
										if (
											window.confirm(t("rejectConfirm"))
										) {
											reject.mutate({
												projectId,
												snapshotId: selected.id,
											});
										}
									}}
								>
									{t("reject")}
								</Button>
							</div>
						) : null}
					</div>
				) : null}
			</DialogContent>
		</Dialog>
	);
}
