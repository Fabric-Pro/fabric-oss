"use client";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { FrameChangeReview } from "./FrameChangeReview";

export function FrameReviewDialog({
	frameId,
	organizationId,
	userId,
	kind,
	onClose,
	onSaved,
	initialProposalId,
	viewedUpdatedAt,
}: {
	frameId: string;
	organizationId: string;
	userId: string;
	kind: "frame" | "slideshow";
	onClose: () => void;
	onSaved: () => Promise<void>;
	initialProposalId?: string;
	viewedUpdatedAt: string | Date;
}) {
	const t = useTranslations("frameChangeReview");
	const [selected, setSelected] = useState<string | undefined>(
		initialProposalId,
	);
	const [offset, setOffset] = useState(0);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState(false);
	const [approval, setApproval] = useState<{
		expectedUpdatedAt: string;
		expectedContentHash: string;
	} | null>(null);
	const confirmApproval = Boolean(approval);
	const viewedRevision = new Date(viewedUpdatedAt).toISOString();
	const key = ["frame-review", organizationId, userId, frameId];
	const state = useQuery({
		queryKey: [...key, "state"],
		queryFn: () =>
			orpcClient.frames.getReview({ id: frameId, organizationId }),
		retry: false,
	});
	const list = useQuery({
		queryKey: [...key, "list", offset],
		queryFn: () =>
			orpcClient.frames.listChanges({
				id: frameId,
				organizationId,
				limit: 20,
				offset,
			}),
		retry: false,
	});
	const proposal = useQuery({
		queryKey: [...key, "proposal", selected],
		queryFn: () =>
			orpcClient.frames.getChange({
				id: frameId,
				organizationId,
				proposalId: selected!,
			}),
		enabled: !!selected,
		retry: false,
	});
	const refresh = async () => {
		await Promise.all([
			state.refetch({ throwOnError: true }),
			list.refetch({ throwOnError: true }),
			onSaved(),
		]);
	};
	const approve = async () => {
		if (!approval) {
			return;
		}
		setBusy(true);
		setError(false);
		try {
			await orpcClient.frames.approveRevision({
				id: frameId,
				organizationId,
				...approval,
			});
			setApproval(null);
			await refresh();
		} catch {
			setError(true);
		} finally {
			setBusy(false);
		}
	};
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !busy) {
					onClose();
				}
			}}
		>
			<DialogContent className="flex max-h-[90dvh] min-h-[min(36rem,80dvh)] max-w-5xl flex-col overflow-hidden">
				<DialogHeader>
					<DialogTitle>{t("heading")}</DialogTitle>
					<DialogDescription>{t("boundary")}</DialogDescription>
				</DialogHeader>
				{selected ? (
					<>
						<Button
							variant="ghost"
							className="self-start"
							onClick={() => setSelected(undefined)}
						>
							{t("back")}
						</Button>
						{proposal.isPending ? (
							<output>{t("loading")}</output>
						) : proposal.isError ? (
							<div role="alert">
								<p>{t("failed")}</p>
								<Button onClick={() => proposal.refetch()}>
									{t("retry")}
								</Button>
							</div>
						) : (
							proposal.data && (
								<FrameChangeReview
									key={
										proposal.data.id +
										proposal.data.currentUpdatedAt
									}
									proposal={proposal.data}
									organizationId={organizationId}
									kind={kind}
									onApplied={async () => {
										await refresh();
										onClose();
									}}
									onDismissed={() => {
										setSelected(undefined);
										void refresh().catch(() =>
											setError(true),
										);
									}}
								/>
							)
						)}
					</>
				) : (
					<>
						{state.isPending ? (
							<output>{t("loading")}</output>
						) : state.isError ? (
							<p role="alert">{t("failed")}</p>
						) : (
							state.data && (
								<div className="space-y-3 border-b border-border pb-4">
									<p className="text-sm">
										{t(
											state.data.hasUnapprovedChanges
												? "unapproved"
												: "approved",
										)}{" "}
										·{" "}
										{t(
											state.data.hasPublicLink &&
												state.data.published
												? state.data
														.hasUnpublishedChanges
													? "publishedOlder"
													: "publishedCurrent"
												: "unpublished",
										)}
									</p>
									<p className="text-xs text-muted-foreground">
										{t("approvalPrivate")}
									</p>

									{state.data.currentUpdatedAt !==
										viewedRevision && (
										<div role="alert" className="space-y-2">
											<p className="text-sm">
												{t("unseenRevision")}
											</p>
											<Button
												variant="outline"
												disabled={busy}
												onClick={async () => {
													setBusy(true);
													setError(false);
													try {
														await onSaved();
														onClose();
													} catch {
														setError(true);
													} finally {
														setBusy(false);
													}
												}}
											>
												{t("reviewLatest")}
											</Button>
										</div>
									)}
									{state.data.currentUpdatedAt ===
										viewedRevision &&
										state.data.hasUnapprovedChanges &&
										!confirmApproval && (
											<Button
												variant="outline"
												onClick={() => {
													const current = state.data;
													if (
														current &&
														current.currentUpdatedAt ===
															viewedRevision
													)
														setApproval({
															expectedUpdatedAt:
																current.currentUpdatedAt,
															expectedContentHash:
																current.currentContentHash,
														});
												}}
											>
												{t("approve")}
											</Button>
										)}
									{confirmApproval &&
										state.data.currentUpdatedAt ===
											viewedRevision && (
											<div
												role="alert"
												className="space-y-2"
											>
												<p className="text-sm">
													{t("approveConfirm")}
												</p>
												<div className="flex flex-wrap gap-2">
													<Button
														variant="outline"
														disabled={busy}
														onClick={() =>
															setApproval(null)
														}
													>
														{t("cancel")}
													</Button>
													<Button
														disabled={busy}
														onClick={approve}
													>
														{t(
															busy
																? "working"
																: "confirmApproval",
														)}
													</Button>
												</div>
											</div>
										)}
								</div>
							)
						)}
						{error && <p role="alert">{t("failed")}</p>}
						<div className="min-h-0 flex-1 overflow-y-auto">
							{list.isPending ? (
								<output>{t("loading")}</output>
							) : list.isError ? (
								<div role="alert">
									<p>{t("failed")}</p>
									<Button onClick={() => list.refetch()}>
										{t("retry")}
									</Button>
								</div>
							) : !list.data?.proposals.length ? (
								<p className="py-8 text-sm text-muted-foreground">
									{t("empty")}
								</p>
							) : (
								<ul className="divide-y divide-border">
									{list.data.proposals.map((p) => (
										<li key={p.id}>
											<button
												type="button"
												className="flex w-full flex-wrap items-center justify-between gap-2 rounded-md p-3 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
												onClick={() =>
													setSelected(p.id)
												}
											>
												<span className="text-sm">
													{new Date(
														p.createdAt,
													).toLocaleString()}
													<span className="block text-xs text-muted-foreground">
														{t("summary", {
															count: p.summary
																.blocks.length,
														})}
													</span>
												</span>
												<span className="text-xs">
													{t(
														p.status === "APPLIED"
															? "applied"
															: p.status ===
																	"DISMISSED"
																? "dismissed"
																: p.conflicted
																	? "needsComparison"
																	: "pending",
													)}
												</span>
											</button>
										</li>
									))}
								</ul>
							)}
						</div>
						<div className="flex shrink-0 items-center justify-between border-t border-border pt-3">
							<Button
								variant="outline"
								disabled={offset === 0 || list.isFetching}
								onClick={() =>
									setOffset((n) => Math.max(0, n - 20))
								}
							>
								{t("previous")}
							</Button>
							<span className="text-xs text-muted-foreground">
								{t("page", { number: offset / 20 + 1 })}
							</span>
							<Button
								variant="outline"
								disabled={
									!list.data?.hasMore || list.isFetching
								}
								onClick={() => setOffset((n) => n + 20)}
							>
								{t("next")}
							</Button>
						</div>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
