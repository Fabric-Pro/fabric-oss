"use client";
import type { FrameChangeProposalView } from "@repo/utils/frame-review-contracts";
import { orpcClient } from "@shared/lib/orpc-client";
import { Button } from "@ui/components/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { type FrameDocumentView, FrameRenderer } from "./FrameRenderer";

/** Preview is deliberately static: reviewing content never executes its proposed tools or scripts. */
export function FrameChangeReview({
	proposal,
	organizationId,
	kind,
	onApplied,
	onDismissed,
}: {
	proposal: FrameChangeProposalView;
	organizationId: string;
	kind: "frame" | "slideshow";
	onApplied: () => Promise<void>;
	onDismissed: () => void;
}) {
	const t = useTranslations("frameChangeReview");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [conflicted, setConflicted] = useState(proposal.conflicted);
	const [current, setCurrent] = useState<FrameDocumentView | null>(null);
	const [applied, setApplied] = useState(proposal.status === "APPLIED");
	const mutate = async (dismiss = false) => {
		setBusy(true);
		setError(null);
		try {
			if (dismiss) {
				await orpcClient.frames.dismissChange({
					id: proposal.frameId,
					organizationId,
					proposalId: proposal.id,
				});
				onDismissed();
			} else {
				if (!applied) {
					await orpcClient.frames.applyChange({
						id: proposal.frameId,
						organizationId,
						proposalId: proposal.id,
						expectedProposalHash: proposal.proposedContentHash,
					});
				}
				setApplied(true);
				await onApplied();
			}
		} catch (e) {
			const conflict =
				!!e &&
				typeof e === "object" &&
				"code" in e &&
				e.code === "CONFLICT";
			if (conflict) {
				setConflicted(true);
			}
			setError(
				t(applied ? "refreshError" : conflict ? "conflict" : "failed"),
			);
		} finally {
			setBusy(false);
		}
	};
	const loadCurrent = async () => {
		setBusy(true);
		setError(null);
		try {
			const latest = await orpcClient.frames.get({
				id: proposal.frameId,
				organizationId,
			});
			setCurrent(latest.document);
		} catch {
			setError(t("failed"));
		} finally {
			setBusy(false);
		}
	};
	const pending = proposal.status === "PENDING" && !applied;
	return (
		<div className="flex min-h-0 flex-1 flex-col gap-4">
			<p className="text-sm text-muted-foreground">
				{t("summary", { count: proposal.summary.blocks.length })}{" "}
				{t("staticPreview")}
			</p>
			{proposal.summary.titleChanged && (
				<p className="text-sm">
					{t("titleChange", {
						before: proposal.base.title,
						after: proposal.proposed.title,
					})}
				</p>
			)}
			{proposal.summary.descriptionChanged && (
				<p className="text-sm">{t("descriptionChange")}</p>
			)}
			{proposal.summary.presentationChanged && (
				<p className="text-sm">{t("presentationChange")}</p>
			)}
			{proposal.summary.themeChanged && (
				<p className="text-sm">{t("themeChange")}</p>
			)}
			{conflicted && (
				<div
					role="alert"
					className="space-y-2 rounded-md border border-border p-3"
				>
					<p>{t("conflict")}</p>
					<Button
						variant="outline"
						onClick={loadCurrent}
						disabled={busy}
					>
						{t("compareCurrent")}
					</Button>
				</div>
			)}
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			<Tabs
				defaultValue="proposed"
				className="flex min-h-0 flex-1 flex-col"
			>
				<TabsList className="flex h-auto flex-wrap justify-start">
					<TabsTrigger value="proposed">{t("preview")}</TabsTrigger>
					<TabsTrigger value="original">{t("original")}</TabsTrigger>
					<TabsTrigger value="changes">{t("changes")}</TabsTrigger>
					{current && (
						<TabsTrigger value="current">
							{t("current")}
						</TabsTrigger>
					)}
				</TabsList>
				<TabsContent
					value="proposed"
					className="min-h-0 flex-1 overflow-y-auto"
				>
					<FrameRenderer
						frame={{ ...proposal.proposed, version: 1, kind }}
						allowScripts={false}
					/>
				</TabsContent>
				<TabsContent
					value="original"
					className="min-h-0 flex-1 overflow-y-auto"
				>
					<FrameRenderer
						frame={{ ...proposal.base, version: 1, kind }}
						allowScripts={false}
					/>
				</TabsContent>
				<TabsContent
					value="changes"
					className="min-h-0 flex-1 space-y-4 overflow-y-auto"
				>
					{proposal.summary.descriptionChanged && (
						<section className="space-y-2">
							<h3 className="text-sm font-medium">
								{t("description")}
							</h3>
							<div className="grid gap-3 sm:grid-cols-2">
								{[proposal.base, proposal.proposed].map(
									(document, index) => (
										<div key={index} className="min-w-0">
											<p className="mb-1 text-xs text-muted-foreground">
												{t(
													index === 0
														? "original"
														: "proposed",
												)}
											</p>
											<p className="whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-sm">
												{document.description ||
													t("noDescription")}
											</p>
										</div>
									),
								)}
							</div>
						</section>
					)}
					{proposal.summary.blocks.map((change) => (
						<section key={change.id} className="space-y-2">
							<h3 className="text-sm font-medium">
								{change.title ?? change.id} · {t(change.change)}
							</h3>
							<div className="grid min-w-0 gap-3 sm:grid-cols-2">
								{[proposal.base, proposal.proposed].map(
									(document, index) => (
										<div key={index} className="min-w-0">
											<p className="mb-1 text-xs text-muted-foreground">
												{t(
													index === 0
														? "original"
														: "proposed",
												)}
											</p>
											<pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs">
												{document.blocks.find(
													(b) => b.id === change.id,
												)?.content ?? t("notPresent")}
											</pre>
										</div>
									),
								)}
							</div>
						</section>
					))}
				</TabsContent>
				{current && (
					<TabsContent
						value="current"
						className="min-h-0 flex-1 overflow-y-auto"
					>
						<FrameRenderer frame={current} allowScripts={false} />
					</TabsContent>
				)}
			</Tabs>
			<div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
				<span className="mr-auto text-xs text-muted-foreground">
					{t(
						pending
							? "notApplied"
							: applied
								? "applied"
								: "dismissed",
					)}
				</span>
				{pending && (
					<Button
						variant="outline"
						disabled={busy}
						onClick={() => mutate(true)}
					>
						{t("dismiss")}
					</Button>
				)}
				{(pending || applied) && (
					<Button
						disabled={busy || (conflicted && !applied)}
						onClick={() => mutate()}
					>
						{t(busy ? "working" : applied ? "refresh" : "apply")}
					</Button>
				)}
			</div>
		</div>
	);
}
