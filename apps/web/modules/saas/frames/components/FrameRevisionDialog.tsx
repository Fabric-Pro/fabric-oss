"use client";

import {
	effectiveFramePresentation,
	type FramePresentation,
} from "@repo/utils/frame-presentation";
import type { FrameChangeProposalView } from "@repo/utils/frame-review-contracts";
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
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import { Textarea } from "@ui/components/textarea";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { FrameChangeReview } from "./FrameChangeReview";
import type { FrameDocumentView } from "./FrameRenderer";

type FrameDraft = {
	id: string;
	title: string;
	updatedAt: string | Date;
	document: FrameDocumentView;
};
export function FrameRevisionDialog({
	frame,
	organizationId,
	userId,
	initialTab,
	onClose,
	onSaved,
}: {
	frame: FrameDraft;
	organizationId: string;
	userId: string;
	initialTab: "edit" | "history";
	onClose: () => void;
	onSaved: () => Promise<void>;
}) {
	const [proposal, setProposal] = useState<FrameChangeProposalView | null>(
		null,
	);
	const request = useRef<{ key: string; id: string } | null>(null);
	const [latest, setLatest] = useState<FrameDocumentView | null>(null);
	const reviewDraft = async () => {
		if (busy || committed) {
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const input = {
				expectedUpdatedAt: revision,
				edit: {
					title,
					blocks,
					...(selectedPresentation !== initialPresentation
						? { presentation: selectedPresentation }
						: {}),
				},
			};
			const key = JSON.stringify(input);
			if (request.current?.key !== key) {
				request.current = { key, id: crypto.randomUUID() };
			}
			const review = await orpcClient.frames.proposeChange({
				id: frame.id,
				organizationId,
				...input,
				requestId: request.current.id,
			});
			setProposal(review);
		} catch (e) {
			setError(
				e &&
					typeof e === "object" &&
					"code" in e &&
					e.code === "CONFLICT"
					? "conflict"
					: "failure",
			);
		} finally {
			setBusy(false);
		}
	};

	const t = useTranslations("frameRevisions");
	const [tab, setTab] = useState(initialTab);
	const [revision, _setRevision] = useState(
		new Date(frame.updatedAt).toISOString(),
	);
	const [title, setTitle] = useState(frame.title);
	const [blocks, setBlocks] = useState(frame.document.blocks);
	const [presentation, setPresentation] = useState(
		frame.document.presentation,
	);
	const reportDocument =
		frame.document.metadata?.sourceRunType === "REPORT_EXECUTION";
	const selectedPresentation = effectiveFramePresentation({
		presentation,
		metadata: frame.document.metadata,
	});
	const [initialPresentation, _setInitialPresentation] = useState(
		effectiveFramePresentation(frame.document),
	);
	const [initial, _setInitial] = useState(
		JSON.stringify({
			title: frame.title,
			blocks: frame.document.blocks,
			presentation: effectiveFramePresentation(frame.document),
		}),
	);
	const [busy, setBusy] = useState(false);
	const [committed, setCommitted] = useState(false);
	const [error, setError] = useState<
		"conflict" | "failure" | "refresh" | null
	>(null);
	const [confirmRestore, setConfirmRestore] = useState<string | null>(null);
	const [confirmDiscard, setConfirmDiscard] = useState(false);
	const dirty =
		JSON.stringify({
			title,
			blocks,
			presentation: selectedPresentation,
		}) !== initial;
	const history = useQuery({
		queryKey: ["frame-history", organizationId, userId, frame.id],
		queryFn: () =>
			orpcClient.frames.getHistory({
				id: frame.id,
				organizationId,
				limit: 200,
			}),
		enabled: tab === "history",
		retry: false,
	});
	const close = () => {
		if (busy) {
			return;
		}
		if (dirty && !committed) {
			setConfirmDiscard(true);
		} else {
			onClose();
		}
	};
	const refreshAfterSave = async () => {
		setBusy(true);
		try {
			await onSaved();
			onClose();
		} catch {
			setError("refresh");
		} finally {
			setBusy(false);
		}
	};
	const mutate = async (action: () => Promise<unknown>) => {
		if (busy || committed) {
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const result = await action();
			if (
				result &&
				typeof result === "object" &&
				"success" in result &&
				result.success === false
			) {
				setError("failure");
				return;
			}
		} catch (error) {
			setError(
				error &&
					typeof error === "object" &&
					"code" in error &&
					error.code === "CONFLICT"
					? "conflict"
					: "failure",
			);
			return;
		} finally {
			setBusy(false);
		}
		setCommitted(true);
		await refreshAfterSave();
	};

	const reload = async () => {
		setBusy(true);
		try {
			const latest = await orpcClient.frames.get({
				id: frame.id,
				organizationId,
			});
			setLatest(latest.document);
			// Keep the unsaved draft and its base revision intact on conflict.

			await history.refetch();
		} catch {
			setError("failure");
		} finally {
			setBusy(false);
		}
	};
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) {
					close();
				}
			}}
		>
			<DialogContent className="flex max-h-[90dvh] max-w-4xl flex-col overflow-hidden">
				<DialogHeader>
					<DialogTitle>
						{t("title", { name: frame.title })}
					</DialogTitle>
					<DialogDescription>{t("boundary")}</DialogDescription>
				</DialogHeader>
				{error && (
					<div
						role="alert"
						className="space-y-2 rounded-md border border-border p-3"
					>
						<p>{t(error)}</p>
						{error === "refresh" && (
							<Button
								variant="outline"
								disabled={busy}
								onClick={refreshAfterSave}
							>
								{t("retryRefresh")}
							</Button>
						)}
						{error === "conflict" && (
							<Button
								variant="outline"
								disabled={busy || committed}
								onClick={reload}
							>
								{t("compareLatest")}
							</Button>
						)}
					</div>
				)}
				{latest && (
					<details className="max-h-48 overflow-auto">
						<summary>{t("latestKept")}</summary>
						<pre className="whitespace-pre-wrap break-words text-xs">
							{JSON.stringify(latest, null, 2)}
						</pre>
					</details>
				)}
				{proposal ? (
					<FrameChangeReview
						proposal={proposal}
						organizationId={organizationId}
						kind={frame.document.kind}
						onApplied={async () => {
							setCommitted(true);
							await onSaved();
							onClose();
						}}
						onDismissed={() => {
							setProposal(null);
							request.current = null;
						}}
					/>
				) : confirmDiscard ? (
					<div role="alert" className="space-y-3">
						<p>{t("discardQuestion")}</p>
						<Button
							variant="outline"
							onClick={() => setConfirmDiscard(false)}
						>
							{t("keepEditing")}
						</Button>
						<Button variant="destructive" onClick={onClose}>
							{t("discard")}
						</Button>
					</div>
				) : (
					<Tabs
						value={tab}
						onValueChange={(value) => {
							setTab(value as "edit" | "history");
							setConfirmRestore(null);
						}}
						className="flex min-h-0 flex-1 flex-col"
					>
						<TabsList>
							<TabsTrigger value="edit">{t("edit")}</TabsTrigger>
							<TabsTrigger value="history">
								{t("history")}
							</TabsTrigger>
						</TabsList>
						<TabsContent
							value="edit"
							className="min-h-0 space-y-4 overflow-y-auto p-1"
						>
							<div className="space-y-2">
								<Label htmlFor="frame-edit-title">
									{t("pageTitle")}
								</Label>
								<Input
									id="frame-edit-title"
									value={title}
									maxLength={300}
									disabled={busy || committed}
									onChange={(event) =>
										setTitle(event.target.value)
									}
								/>
							</div>

							<div className="space-y-2">
								<Label htmlFor="frame-presentation">
									{t("presentation")}
								</Label>
								<Select
									value={selectedPresentation}
									disabled={
										busy || committed || reportDocument
									}
									onValueChange={(value) =>
										setPresentation(
											value as FramePresentation,
										)
									}
								>
									<SelectTrigger
										id="frame-presentation"
										aria-describedby="frame-presentation-summary"
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="DOCUMENT">
											{t("documentPresentation")}
										</SelectItem>
										<SelectItem value="INTERFACE">
											{t("interfacePresentation")}
										</SelectItem>
									</SelectContent>
								</Select>
								<p
									id="frame-presentation-summary"
									className="text-sm text-muted-foreground"
								>
									{t(
										reportDocument
											? "reportPresentationSummary"
											: selectedPresentation ===
													"INTERFACE"
												? "interfacePresentationSummary"
												: "documentPresentationSummary",
									)}
								</p>
							</div>
							{blocks.map((block, index) => (
								<div key={block.id} className="space-y-2">
									<Label htmlFor={`frame-block-${index}`}>
										{t("block", {
											number: index + 1,
											type: block.type,
										})}
									</Label>
									<Textarea
										id={`frame-block-${index}`}
										value={block.content}
										disabled={busy || committed}
										className="min-h-48 font-mono text-sm"
										onChange={(event) =>
											setBlocks((current) =>
												current.map((item, n) =>
													n === index
														? {
																...item,
																content:
																	event.target
																		.value,
															}
														: item,
												),
											)
										}
									/>
								</div>
							))}
						</TabsContent>
						<TabsContent
							value="history"
							className="min-h-0 flex-1 space-y-3 overflow-y-auto p-1"
						>
							{history.isPending ? (
								<output>{t("loading")}</output>
							) : history.isError ? (
								<div role="alert">
									<p>{t("historyError")}</p>
									<Button
										variant="outline"
										onClick={() => history.refetch()}
									>
										{t("retry")}
									</Button>
								</div>
							) : history.data?.history.length === 0 ? (
								<p>{t("empty")}</p>
							) : (
								<ul className="divide-y divide-border">
									{history.data?.history.map((entry) => (
										<li
											key={entry.id}
											className="flex items-center justify-between gap-3 py-3"
										>
											<div>
												<p className="text-sm font-medium">
													{new Date(
														entry.editedAt,
													).toLocaleString()}
												</p>
												<p className="text-xs text-muted-foreground">
													{entry.editType === "revert"
														? t("restored")
														: t("saved")}
													{!entry.canRestore
														? ` · ${t("unavailable")}`
														: ""}
												</p>
											</div>
											<Button
												variant="outline"
												size="sm"
												disabled={
													busy ||
													committed ||
													!entry.canRestore ||
													dirty
												}
												onClick={() =>
													setConfirmRestore(entry.id)
												}
											>
												{t("restore")}
											</Button>
										</li>
									))}
								</ul>
							)}
							{dirty && (
								<p className="text-sm text-muted-foreground">
									{t("unsavedHistory")}
								</p>
							)}
							{confirmRestore && (
								<div
									role="alert"
									className="space-y-3 rounded-md border border-border p-3"
								>
									<p>{t("restoreQuestion")}</p>
									<div className="flex gap-2">
										<Button
											variant="outline"
											disabled={busy || committed}
											onClick={() =>
												setConfirmRestore(null)
											}
										>
											{t("cancel")}
										</Button>
										<Button
											disabled={busy || committed}
											onClick={() =>
												mutate(() =>
													orpcClient.frames.revert({
														id: frame.id,
														organizationId,
														historyEntryId:
															confirmRestore,
														expectedUpdatedAt:
															revision,
													}),
												)
											}
										>
											{busy
												? t("saving")
												: t("confirmRestore")}
										</Button>
									</div>
								</div>
							)}
						</TabsContent>
					</Tabs>
				)}
				{!confirmDiscard && !proposal && (
					<div className="flex shrink-0 justify-end gap-2 border-t border-border pt-3">
						<Button
							variant="outline"
							disabled={busy}
							onClick={close}
						>
							{t("cancel")}
						</Button>
						{tab === "edit" && (
							<Button
								disabled={
									busy ||
									committed ||
									!dirty ||
									!title.trim() ||
									Boolean(error === "conflict")
								}
								onClick={reviewDraft}
							>
								{busy ? t("saving") : t("reviewChanges")}
							</Button>
						)}
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
