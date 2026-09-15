"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ui/components/alert-dialog";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Label } from "@ui/components/label";
import { Textarea } from "@ui/components/textarea";
import { cn } from "@ui/lib";
import {
	CheckCircleIcon,
	CircleXIcon,
	ExternalLinkIcon,
	FlaskConicalIcon,
	Loader2Icon,
	PlayIcon,
	Trash2Icon,
} from "lucide-react";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { toast } from "sonner";
import { discardSpikeRun, type SpikeRunView } from "../../lib/spike-runs";
import { AcceptSpikeDialog } from "../stories/AcceptSpikeDialog";
import { invalidateStoryReadiness } from "../stories/useStoryReadiness";

type Props = {
	run: SpikeRunView;
	projectId: string;
	storyId: string;
	className?: string;
	/** Compact variant for lists (evidence section). */
	compact?: boolean;
};

const FINDINGS_PREVIEW_LENGTH = 600;

// Markdown renderer is loaded on demand: it pulls in the streaming markdown
// stack (katex etc.), which only spike runs with findings need.
const FindingsMarkdown = dynamic(
	() =>
		import("../../../../../components/ai-elements/response").then(
			(m) => m.Response,
		),
	{
		ssr: false,
		loading: () => (
			<p className="text-sm text-muted-foreground">Loading findings…</p>
		),
	},
);

function findingsPreview(findings: string): {
	text: string;
	truncated: boolean;
} {
	if (findings.length <= FINDINGS_PREVIEW_LENGTH) {
		return { text: findings, truncated: false };
	}
	return {
		text: `${findings.slice(0, FINDINGS_PREVIEW_LENGTH).trimEnd()}…`,
		truncated: true,
	};
}

/**
 * A spike run as a card: question, status, demo link, findings preview and
 * play notes. In `DEMO_READY` it offers "Accept findings" and "Discard".
 */
export function SpikeRunCard({
	run,
	projectId,
	storyId,
	className,
	compact = false,
}: Props) {
	const t = useTranslations("projects.stories.spike");
	const { organizationId } = useOrganizationContext();
	const queryClient = useQueryClient();
	const [acceptOpen, setAcceptOpen] = useState(false);
	const [discardOpen, setDiscardOpen] = useState(false);
	const [discardReason, setDiscardReason] = useState("");
	const [showFullFindings, setShowFullFindings] = useState(false);
	const reasonId = useId();

	const isDemoReady = run.status === "DEMO_READY";
	const isCompleted = run.status === "COMPLETED";
	const isTerminalFailure =
		run.status === "FAILED" || run.status === "CANCELLED";
	const isInFlight = !isDemoReady && !isCompleted && !isTerminalFailure;

	const discardMutation = useMutation({
		mutationFn: async () =>
			await discardSpikeRun({
				codingRunId: run.id,
				projectId,
				organizationId: organizationId ?? null,
				reason: discardReason.trim() || undefined,
			}),
		onSuccess: async () => {
			await Promise.all([
				queryClient.invalidateQueries({
					queryKey: orpc.codingRuns.list.key(),
				}),
				queryClient.invalidateQueries({
					queryKey: ["codingRun", run.id],
				}),
				queryClient.invalidateQueries({
					queryKey: orpc.projects.stories.list.key(),
				}),
				invalidateStoryReadiness(queryClient, { projectId, storyId }),
			]);
			toast.success(t("discard.success"));
			setDiscardOpen(false);
			setDiscardReason("");
		},
		onError: (error) => {
			toast.error(t("discard.failed"), { description: error.message });
		},
	});

	const preview = run.findings ? findingsPreview(run.findings) : null;

	return (
		<article
			className={cn(
				"rounded-2xl border border-border/60 bg-card",
				compact ? "p-4" : "p-5",
				isDemoReady && "border-secondary/40",
				className,
			)}
			aria-labelledby={`${reasonId}-title`}
		>
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0 flex-1 space-y-2">
					<div className="flex flex-wrap items-center gap-2">
						<Badge
							variant="outline"
							className="rounded-full border-primary/20 bg-primary/5 px-2.5 py-0.5 text-[11px] uppercase tracking-[0.16em] text-primary"
						>
							<FlaskConicalIcon className="mr-1 size-3" />
							{t("kindBadge")}
						</Badge>
						<SpikeStatusBadge status={run.status} />
					</div>
					<p
						id={`${reasonId}-title`}
						className={cn(
							"font-medium leading-6 text-foreground",
							compact ? "text-sm" : "text-base",
						)}
					>
						{run.spikeQuestion ?? t("untitledQuestion")}
					</p>
				</div>
				{run.demoUrl && (isDemoReady || isCompleted) && (
					<Button asChild size="sm" variant="outline">
						<a
							href={run.demoUrl}
							target="_blank"
							rel="noopener noreferrer"
						>
							<PlayIcon className="mr-2 size-3.5" />
							{t("openDemo")}
							<ExternalLinkIcon className="ml-2 size-3 text-muted-foreground" />
						</a>
					</Button>
				)}
			</div>

			{isDemoReady && (
				<p className="mt-3 text-sm leading-6 text-muted-foreground">
					{t("demoReadyHint")}
				</p>
			)}

			{isInFlight && (
				<p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
					<Loader2Icon className="size-3.5 motion-safe:animate-spin" />
					{t("inFlight")}
				</p>
			)}

			{isTerminalFailure && run.error && (
				<p className="mt-3 text-sm leading-6 text-destructive">
					{run.error}
				</p>
			)}

			{preview && (
				<section className="mt-4 space-y-2">
					<p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
						{t("findingsLabel")}
					</p>
					<div className="prose prose-sm dark:prose-invert max-w-none rounded-xl border border-border/50 bg-muted/30 p-3 text-sm leading-6">
						<FindingsMarkdown>
							{showFullFindings
								? (run.findings ?? "")
								: preview.text}
						</FindingsMarkdown>
					</div>
					{preview.truncated && (
						<Button
							type="button"
							variant="link"
							size="sm"
							className="h-auto px-0"
							onClick={() =>
								setShowFullFindings((value) => !value)
							}
						>
							{showFullFindings
								? t("showLessFindings")
								: t("showAllFindings")}
						</Button>
					)}
				</section>
			)}

			{run.playNotes && (
				<section className="mt-4 space-y-2">
					<p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
						{t("playNotesLabel")}
					</p>
					<p className="whitespace-pre-wrap text-sm leading-6 text-foreground/85">
						{run.playNotes}
					</p>
				</section>
			)}

			{isDemoReady && (
				<div className="mt-4 flex flex-wrap items-center gap-2">
					<Button
						type="button"
						size="sm"
						onClick={() => setAcceptOpen(true)}
					>
						<CheckCircleIcon className="mr-2 size-3.5" />
						{t("acceptFindings")}
					</Button>
					<Button
						type="button"
						size="sm"
						variant="outline"
						onClick={() => setDiscardOpen(true)}
					>
						<Trash2Icon className="mr-2 size-3.5" />
						{t("discard.action")}
					</Button>
				</div>
			)}

			<AcceptSpikeDialog
				open={acceptOpen}
				onOpenChange={setAcceptOpen}
				codingRunId={run.id}
				projectId={projectId}
				storyId={storyId}
				question={run.spikeQuestion}
			/>

			<AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{t("discard.title")}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{t("discard.description")}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<div className="space-y-2">
						<Label htmlFor={reasonId}>
							{t("discard.reasonLabel")}
						</Label>
						<Textarea
							id={reasonId}
							value={discardReason}
							onChange={(event) =>
								setDiscardReason(event.target.value)
							}
							rows={3}
							placeholder={t("discard.reasonPlaceholder")}
							className="resize-none text-sm"
						/>
					</div>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={discardMutation.isPending}>
							{t("cancel")}
						</AlertDialogCancel>
						<AlertDialogAction
							onClick={(event) => {
								event.preventDefault();
								discardMutation.mutate();
							}}
							disabled={discardMutation.isPending}
						>
							{discardMutation.isPending ? (
								<>
									<Loader2Icon className="mr-2 size-4 motion-safe:animate-spin" />
									{t("discard.submitting")}
								</>
							) : (
								t("discard.confirm")
							)}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</article>
	);
}

function SpikeStatusBadge({ status }: { status: SpikeRunView["status"] }) {
	const t = useTranslations("projects.stories.spike.status");
	switch (status) {
		case "DEMO_READY":
			return (
				<Badge
					variant="outline"
					className="gap-1 rounded-full border-secondary/40 bg-secondary/10 px-2.5 py-0.5 text-[11px] text-secondary"
				>
					<PlayIcon className="size-3" />
					{t("DEMO_READY")}
				</Badge>
			);
		case "COMPLETED":
			return (
				<Badge
					variant="secondary"
					className="gap-1 rounded-full px-2.5 py-0.5 text-[11px]"
				>
					<CheckCircleIcon className="size-3" />
					{t("COMPLETED")}
				</Badge>
			);
		case "FAILED":
			return (
				<Badge
					variant="destructive"
					className="gap-1 rounded-full px-2.5 py-0.5 text-[11px]"
				>
					<CircleXIcon className="size-3" />
					{t("FAILED")}
				</Badge>
			);
		case "CANCELLED":
			return (
				<Badge
					variant="outline"
					className="gap-1 rounded-full px-2.5 py-0.5 text-[11px]"
				>
					<CircleXIcon className="size-3" />
					{t("CANCELLED")}
				</Badge>
			);
		default:
			return (
				<Badge
					variant="outline"
					className="gap-1 rounded-full px-2.5 py-0.5 text-[11px]"
				>
					<Loader2Icon className="size-3 motion-safe:animate-spin" />
					{t("RUNNING")}
				</Badge>
			);
	}
}
