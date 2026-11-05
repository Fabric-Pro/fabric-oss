"use client";

import { Pagination } from "@saas/shared/components/Pagination";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { cn } from "@ui/lib";
import { BookOpenTextIcon, ChevronDownIcon, XIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { formatDecisionDate } from "./constants";

type LivingMemoryCandidate = {
	extractionId: string;
	decisionIndex: number;
	sourcePath: string;
	extractedAt: string | Date;
	text: string;
	rationale?: string;
	matchedDecision?: { id: string; identifier: string; title: string };
};

const CANDIDATE_PAGE_SIZE = 10;

const candidateKey = (c: LivingMemoryCandidate) =>
	`${c.extractionId}:${c.decisionIndex}`;

/**
 * Decisions an AI found in the project's synced Living Memory files, offered
 * for review beside the meeting candidates. Renders nothing until a candidate
 * exists or a repository's first sync left files unread, so a project without
 * synced files sees no strip at all.
 *
 * Nothing is written until a reviewer accepts. A candidate that reads like an
 * existing decision offers "Create as update", which links the new PROPOSED
 * decision to the existing one; accepting it later supersedes the existing one.
 *
 * A repository's first sync does not read its files for decisions, since that
 * is one AI request per file. The strip says how many it left and lets a member
 * scan them; the files' candidates then arrive here as the scan reads them.
 */
export function LivingMemoryCandidatesStrip({
	projectId,
	organizationId,
	canEdit,
	onCreated,
}: {
	projectId: string;
	organizationId?: string | null;
	canEdit: boolean;
	onCreated: (decisionId: string) => void;
}) {
	const t = useTranslations("projects.livingMemoryDecisions");
	const [open, setOpen] = useState(false);
	const [page, setPage] = useState(0);
	const [preview, setPreview] = useState<LivingMemoryCandidate | null>(null);

	const candidatesQuery = useQuery(
		orpc.projects.architectureDecisions.livingMemoryDecisions.list.queryOptions(
			{ input: { projectId, organizationId: organizationId ?? null } },
		),
	);
	const candidates: LivingMemoryCandidate[] =
		candidatesQuery.data?.candidates ?? [];
	const skippedFileCount = candidatesQuery.data?.filesSkippedAtFirstSync ?? 0;

	const scanMutation = useMutation(
		orpc.projects.architectureDecisions.livingMemoryDecisions.scanFirstSync.mutationOptions(
			{
				onSuccess: () => {
					toast.success(t("toast.scanStarted"));
					candidatesQuery.refetch();
				},
				onError: (e) =>
					toast.error(t("toast.scanFailed", { message: e.message })),
			},
		),
	);

	const createMutation = useMutation(
		orpc.projects.architectureDecisions.livingMemoryDecisions.createFrom.mutationOptions(
			{
				onSuccess: (data) => {
					toast.success(t("toast.created"));
					setPreview(null);
					candidatesQuery.refetch();
					onCreated(data.decision.id);
				},
				onError: (e) =>
					toast.error(
						t("toast.createFailed", { message: e.message }),
					),
			},
		),
	);

	const dismissMutation = useMutation(
		orpc.projects.architectureDecisions.livingMemoryDecisions.dismiss.mutationOptions(
			{
				onSuccess: () => {
					toast.success(t("toast.dismissed"));
					setPreview(null);
					candidatesQuery.refetch();
				},
				onError: (e) =>
					toast.error(
						t("toast.dismissFailed", { message: e.message }),
					),
			},
		),
	);

	if (candidates.length === 0 && skippedFileCount === 0) {
		return null;
	}

	const scanNotice =
		skippedFileCount > 0 ? (
			<div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 text-sm">
				<span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
					<BookOpenTextIcon className="size-4" aria-hidden />
				</span>
				<p className="min-w-0 flex-1 text-muted-foreground">
					{t("strip.firstSyncSkipped", { count: skippedFileCount })}
				</p>
				{canEdit && (
					<Button
						size="sm"
						variant="outline"
						disabled={scanMutation.isPending}
						onClick={() =>
							scanMutation.mutate({
								projectId,
								organizationId: organizationId ?? null,
							})
						}
					>
						{t("strip.scanFirstSync")}
					</Button>
				)}
			</div>
		) : null;

	if (candidates.length === 0) {
		return (
			<div className="overflow-hidden rounded-lg border border-primary/20 bg-primary/[0.03]">
				{scanNotice}
			</div>
		);
	}

	const create = (c: LivingMemoryCandidate, asUpdate: boolean) =>
		createMutation.mutate({
			projectId,
			organizationId: organizationId ?? null,
			extractionId: c.extractionId,
			decisionIndex: c.decisionIndex,
			...(asUpdate && c.matchedDecision
				? { updatesDecisionId: c.matchedDecision.id }
				: {}),
		});
	const dismiss = (c: LivingMemoryCandidate) =>
		dismissMutation.mutate({
			projectId,
			organizationId: organizationId ?? null,
			extractionId: c.extractionId,
			decisionIndex: c.decisionIndex,
		});

	const pageCount = Math.max(
		1,
		Math.ceil(candidates.length / CANDIDATE_PAGE_SIZE),
	);
	// `page` can briefly point past the end after a create/dismiss shrinks the
	// list; clamp for rendering.
	const safePage = Math.min(page, pageCount - 1);
	const visible = candidates.slice(
		safePage * CANDIDATE_PAGE_SIZE,
		safePage * CANDIDATE_PAGE_SIZE + CANDIDATE_PAGE_SIZE,
	);

	return (
		<div className="overflow-hidden rounded-lg border border-primary/20 bg-primary/[0.03]">
			<LivingMemoryCandidateDialog
				candidate={preview}
				creating={createMutation.isPending}
				dismissing={dismissMutation.isPending}
				onClose={() => setPreview(null)}
				onCreate={create}
				onDismiss={dismiss}
			/>
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				className="flex w-full items-center gap-2.5 px-4 py-3 text-left"
				aria-expanded={open}
				aria-label={t("strip.toggleAria")}
			>
				<span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
					<BookOpenTextIcon className="size-4" aria-hidden />
				</span>
				<span className="flex-1 text-sm">
					<strong className="font-semibold">
						{t("strip.count", { count: candidates.length })}
					</strong>{" "}
					<span className="text-muted-foreground">
						{t("strip.detected")}
					</span>
				</span>
				<span className="hidden text-muted-foreground text-xs md:inline">
					{t("strip.subtitle")}
				</span>
				<span className="inline-flex items-center gap-1 font-medium text-primary text-sm">
					{open ? t("strip.hide") : t("strip.review")}
					<ChevronDownIcon
						className={cn(
							"size-4 motion-safe:transition-transform",
							open && "rotate-180",
						)}
						aria-hidden
					/>
				</span>
			</button>
			{open && (
				<ul className="space-y-2 border-primary/10 border-t p-3">
					{visible.map((c) => (
						<li
							key={candidateKey(c)}
							className="flex items-start gap-3 rounded-md border bg-card p-3"
						>
							<BookOpenTextIcon
								className="mt-0.5 size-4 shrink-0 text-muted-foreground"
								aria-hidden
							/>
							<div className="min-w-0 flex-1">
								<p className="text-sm">{c.text}</p>
								<p className="mt-0.5 break-words text-muted-foreground text-xs">
									<span className="font-mono">
										{c.sourcePath}
									</span>
									{` · ${formatDecisionDate(c.extractedAt)}`}
									{c.matchedDecision && (
										<>
											{" · "}
											<span className="font-medium text-highlight">
												{t("strip.mayUpdate", {
													identifier:
														c.matchedDecision
															.identifier,
												})}
											</span>
										</>
									)}
								</p>
							</div>
							{canEdit && (
								<div className="flex shrink-0 items-center gap-1">
									<Button
										size="sm"
										variant="outline"
										onClick={() => setPreview(c)}
									>
										{t("strip.review")}
									</Button>
									<Button
										size="icon"
										variant="ghost"
										className="size-8 text-muted-foreground hover:text-foreground"
										disabled={dismissMutation.isPending}
										title={t("strip.dismissTitle")}
										aria-label={t("strip.dismiss")}
										onClick={() => dismiss(c)}
									>
										<XIcon className="size-4" />
									</Button>
								</div>
							)}
						</li>
					))}
				</ul>
			)}
			{open && pageCount > 1 && (
				<Pagination
					totalItems={candidates.length}
					itemsPerPage={CANDIDATE_PAGE_SIZE}
					currentPage={safePage + 1}
					onChangeCurrentPage={(next) => setPage(next - 1)}
					navigationLabel={t("strip.paginationLabel")}
					previousLabel={t("strip.previousPage")}
					nextLabel={t("strip.nextPage")}
				/>
			)}
			{scanNotice && (
				<div className="border-primary/10 border-t">{scanNotice}</div>
			)}
		</div>
	);
}

/**
 * Review one candidate before anything is written. For a candidate that reads
 * like an existing decision, the existing decision's statement is shown beside
 * the proposed one, and "Create as update" is the primary action.
 */
function LivingMemoryCandidateDialog({
	candidate,
	creating,
	dismissing,
	onClose,
	onCreate,
	onDismiss,
}: {
	candidate: LivingMemoryCandidate | null;
	creating: boolean;
	dismissing: boolean;
	onClose: () => void;
	onCreate: (c: LivingMemoryCandidate, asUpdate: boolean) => void;
	onDismiss: (c: LivingMemoryCandidate) => void;
}) {
	const t = useTranslations("projects.livingMemoryDecisions");
	const matched = candidate?.matchedDecision;
	const source = candidate
		? {
				path: candidate.sourcePath,
				date: formatDecisionDate(candidate.extractedAt),
			}
		: { path: "", date: "" };

	return (
		<Dialog
			open={Boolean(candidate)}
			onOpenChange={(o) => {
				if (!o) {
					onClose();
				}
			}}
		>
			<DialogContent className="max-w-2xl">
				<DialogHeader>
					<div className="flex items-center gap-2">
						<span
							className={cn(
								"inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-medium text-[11px]",
								matched
									? "border-highlight/40 bg-highlight/10 text-highlight"
									: "border-primary/30 bg-primary/5 text-primary",
							)}
						>
							<BookOpenTextIcon className="size-3" aria-hidden />
							{matched
								? t("dialog.updateBadge", {
										identifier: matched.identifier,
									})
								: t("dialog.newBadge")}
						</span>
					</div>
					<DialogTitle>
						{matched
							? t("dialog.titleUpdate")
							: t("dialog.titleNew")}
					</DialogTitle>
					<DialogDescription>
						{matched
							? t("dialog.descriptionUpdate", {
									...source,
									identifier: matched.identifier,
								})
							: t("dialog.descriptionNew", source)}
					</DialogDescription>
				</DialogHeader>

				<div className={cn("grid gap-3", matched && "sm:grid-cols-2")}>
					{matched && (
						<div className="rounded-md border bg-muted/40 p-3">
							<p className="mb-1.5 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
								{t("dialog.current", {
									identifier: matched.identifier,
								})}
							</p>
							<p className="text-sm">{matched.title}</p>
						</div>
					)}
					<div className="rounded-md border border-primary/30 bg-primary/[0.03] p-3">
						<p className="mb-1.5 font-medium text-[11px] text-primary uppercase tracking-wide">
							{t("dialog.proposed")}
						</p>
						<p className="whitespace-pre-wrap text-sm">
							{candidate?.text}
						</p>
						{candidate?.rationale && (
							<p className="mt-2 whitespace-pre-wrap text-muted-foreground text-sm">
								<span className="font-medium text-foreground">
									{t("dialog.rationale")}
								</span>{" "}
								{candidate.rationale}
							</p>
						)}
					</div>
				</div>

				<DialogFooter className="gap-2 sm:items-center sm:justify-between">
					<Button
						variant="ghost"
						className="text-muted-foreground hover:text-destructive"
						disabled={dismissing}
						onClick={() => {
							if (candidate) {
								onDismiss(candidate);
							}
						}}
					>
						{t("dialog.reject")}
					</Button>
					<div className="flex flex-wrap gap-2">
						<Button variant="outline" onClick={onClose}>
							{t("dialog.cancel")}
						</Button>
						{matched && (
							<Button
								variant="outline"
								disabled={creating}
								onClick={() => {
									if (candidate) {
										onCreate(candidate, false);
									}
								}}
							>
								{t("dialog.createNew")}
							</Button>
						)}
						<Button
							disabled={creating}
							onClick={() => {
								if (candidate) {
									onCreate(candidate, Boolean(matched));
								}
							}}
						>
							{matched
								? t("dialog.createAsUpdate")
								: t("dialog.create")}
						</Button>
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
