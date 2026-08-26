"use client";

/**
 * ContextSummaryReaderActions — the admin/reader action cluster mounted into the
 * full-page context summary reader. Renders a "History" control (any member) and
 * an "Edit" control (project admins), each opening its own overlay:
 *
 * - Edit → a `<Dialog>` hosting the `ContextSummaryEditor` form.
 * - History → a right `<Sheet>` listing every generated run and manual edit, with
 *   per-version View (read-only markdown) and admin-only Restore.
 *
 * Mutations that change the server-rendered summary call `router.refresh()` so the
 * reader repaints with the new current version.
 */

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@ui/components/sheet";
import { Skeleton } from "@ui/components/skeleton";
import { EyeIcon, HistoryIcon, PencilIcon, RotateCcwIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { ContextSummaryEditor } from "./ContextSummaryEditor";
import {
	ContextSummaryMarkdown,
	type SummaryReference,
} from "./ContextSummaryMarkdown";

// Mirror of the panel's admin gate — only these project roles may edit/restore.
const ADMIN_ROLES = new Set([
	"owner",
	"admin",
	"project_admin",
	"PROJECT_ADMIN",
]);

// Source-selection chips, in display order; keys align with `editor.groups.*`.
const SOURCE_KEYS = ["context", "decisions", "roadmap", "codeRepo"] as const;

// Exact version shape derived from the procedure output — never drifts from the API.
type SummaryVersion = Awaited<
	ReturnType<typeof orpc.projects.contexts.summaryHistory.call>
>["versions"][number];

type Props = {
	projectId: string;
	organizationId: string | null;
	summaryId: string;
	content: string;
	references: SummaryReference[];
};

export function ContextSummaryReaderActions({
	projectId,
	organizationId,
	summaryId,
	content,
	references,
}: Props) {
	const t = useTranslations("projects.contextSummary");
	const router = useRouter();
	const [editOpen, setEditOpen] = useState(false);
	const [historyOpen, setHistoryOpen] = useState(false);

	const projectQuery = useQuery(
		orpc.projects.get.queryOptions({
			input: { id: projectId, organizationId },
		}),
	);
	const isAdmin = ADMIN_ROLES.has(projectQuery.data?.project?.userRole ?? "");

	const historyQuery = useQuery(
		orpc.projects.contexts.summaryHistory.queryOptions({
			input: { projectId, organizationId },
			enabled: historyOpen,
		}),
	);
	const versions = historyQuery.data?.versions ?? [];

	return (
		<div className="flex items-center gap-2">
			<Button
				type="button"
				variant="outline"
				size="sm"
				className="gap-2"
				onClick={() => setHistoryOpen(true)}
			>
				<HistoryIcon className="size-4" aria-hidden="true" />
				{t("reader.history")}
			</Button>
			{isAdmin && (
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="gap-2"
					onClick={() => setEditOpen(true)}
				>
					<PencilIcon className="size-4" aria-hidden="true" />
					{t("reader.edit")}
				</Button>
			)}

			<Dialog open={editOpen} onOpenChange={setEditOpen}>
				<DialogContent className="sm:max-w-3xl">
					<DialogHeader>
						<DialogTitle className="font-serif font-normal text-2xl">
							{t("editor.title")}
						</DialogTitle>
						<DialogDescription className="sr-only">
							{t("editor.description")}
						</DialogDescription>
					</DialogHeader>
					<ContextSummaryEditor
						projectId={projectId}
						organizationId={organizationId}
						summaryId={summaryId}
						initialContent={content}
						initialReferences={references}
						onSaved={() => {
							setEditOpen(false);
							router.refresh();
						}}
						onCancel={() => setEditOpen(false)}
					/>
				</DialogContent>
			</Dialog>

			<Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
				<SheetContent
					side="right"
					className="flex w-full flex-col sm:max-w-lg"
				>
					<SheetHeader>
						<SheetTitle className="font-serif font-normal text-2xl">
							{t("history.title")}
						</SheetTitle>
						<SheetDescription>
							{t("history.description")}
						</SheetDescription>
					</SheetHeader>

					<div className="-mx-6 mt-4 flex-1 space-y-3 overflow-y-auto px-6">
						{historyQuery.isLoading && (
							<div className="space-y-3">
								<Skeleton className="h-24 w-full rounded-lg" />
								<Skeleton className="h-24 w-full rounded-lg" />
								<Skeleton className="h-24 w-full rounded-lg" />
							</div>
						)}
						{historyQuery.isError && (
							<p className="text-destructive text-sm">
								{t("history.loadError")}
							</p>
						)}
						{historyQuery.isSuccess && versions.length === 0 && (
							<p className="text-muted-foreground text-sm">
								{t("history.empty")}
							</p>
						)}
						{versions.map((version) => (
							<HistoryVersionCard
								key={version.id}
								version={version}
								projectId={projectId}
								organizationId={organizationId}
								isAdmin={isAdmin}
								onRestored={() => {
									setHistoryOpen(false);
									router.refresh();
								}}
							/>
						))}
					</div>
				</SheetContent>
			</Sheet>
		</div>
	);
}

function HistoryVersionCard({
	version,
	projectId,
	organizationId,
	isAdmin,
	onRestored,
}: {
	version: SummaryVersion;
	projectId: string;
	organizationId: string | null;
	isAdmin: boolean;
	onRestored: () => void;
}) {
	const t = useTranslations("projects.contextSummary");
	const [viewOpen, setViewOpen] = useState(false);

	const originLabel = version.manualEdit
		? t("history.origin.edit")
		: version.trigger === "AUTO"
			? t("history.origin.auto")
			: t("history.origin.manual");

	const isCompleted = version.status === "COMPLETED";
	const isFailed = version.status === "FAILED";
	const isCancelled = version.status === "CANCELLED";
	const createdAt = new Date(version.createdAt).toLocaleString();

	const versionQuery = useQuery(
		orpc.projects.contexts.getSummaryVersion.queryOptions({
			input: { projectId, summaryId: version.id, organizationId },
			enabled: viewOpen,
		}),
	);

	const restoreMutation = useMutation({
		mutationFn: () =>
			orpc.projects.contexts.restoreSummaryVersion.call({
				projectId,
				summaryId: version.id,
				organizationId,
			}),
		onSuccess: () => {
			toast.success(t("history.restored"));
			onRestored();
		},
		onError: () => {
			toast.error(t("history.restoreError"));
		},
	});

	const tokensLabel =
		version.spentTotalTokens != null
			? t("history.tokens", { count: version.spentTotalTokens })
			: t("history.noTokens");

	return (
		<div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
			<div className="flex flex-wrap items-center gap-2">
				<span className="font-medium text-foreground text-sm">
					{originLabel}
				</span>
				{version.isCurrent && (
					<Badge variant="secondary">{t("history.current")}</Badge>
				)}
				{isFailed && (
					<span className="text-destructive text-xs">
						{t("history.failedLabel")}
					</span>
				)}
				{isCancelled && (
					<span className="text-muted-foreground text-xs">
						{t("history.cancelledLabel")}
					</span>
				)}
				<span className="ml-auto text-muted-foreground text-xs">
					{createdAt}
				</span>
			</div>

			<div className="flex flex-wrap items-center gap-1.5 text-muted-foreground text-xs">
				<span>{tokensLabel}</span>
				{SOURCE_KEYS.map((key) =>
					version.sourceSelection[key] ? (
						<Badge
							key={key}
							variant="outline"
							className="text-[0.65rem]"
						>
							{t(`editor.groups.${key}`)}
						</Badge>
					) : null,
				)}
			</div>

			{isCompleted && (
				<div className="flex items-center gap-1">
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="gap-1.5"
						onClick={() => setViewOpen(true)}
					>
						<EyeIcon className="size-4" aria-hidden="true" />
						{t("history.view")}
					</Button>
					{isAdmin && !version.isCurrent && (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="gap-1.5"
							onClick={() => restoreMutation.mutate()}
							disabled={restoreMutation.isPending}
						>
							<RotateCcwIcon
								className="size-4"
								aria-hidden="true"
							/>
							{t("history.restore")}
						</Button>
					)}
				</div>
			)}

			<Dialog open={viewOpen} onOpenChange={setViewOpen}>
				<DialogContent className="sm:max-w-3xl">
					<DialogHeader>
						<DialogTitle className="font-serif font-normal text-2xl">
							{originLabel}
						</DialogTitle>
						<DialogDescription>{createdAt}</DialogDescription>
					</DialogHeader>
					{versionQuery.isLoading && (
						<div className="space-y-2">
							<Skeleton className="h-5 w-full" />
							<Skeleton className="h-5 w-5/6" />
							<Skeleton className="h-5 w-2/3" />
						</div>
					)}
					{versionQuery.isError && (
						<p className="text-destructive text-sm">
							{t("history.loadError")}
						</p>
					)}
					{versionQuery.isSuccess && (
						<div className="prose prose-stone dark:prose-invert max-h-[60vh] max-w-none overflow-y-auto prose-headings:font-serif prose-headings:font-normal">
							<ContextSummaryMarkdown
								content={versionQuery.data.version.content}
								references={
									versionQuery.data.version.references
								}
								projectId={projectId}
								summaryId={version.id}
								organizationId={organizationId}
							/>
						</div>
					)}
				</DialogContent>
			</Dialog>
		</div>
	);
}
