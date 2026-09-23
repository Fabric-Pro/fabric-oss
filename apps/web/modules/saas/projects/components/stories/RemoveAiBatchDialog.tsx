"use client";

/**
 * Remove AI Recommended Items (Fizzy #2211): hide the eligible items of ONE
 * recommendation batch, in three steps — pick a batch, review exactly what
 * will be hidden, then read the itemized result.
 *
 * The confirm sends the previewed eligible ids back as `expectedStoryIds`, so
 * an item that became eligible after the preview is never hidden unseen. The
 * server re-checks every item; this dialog only reports what it did.
 */

import { ORPCError } from "@orpc/client";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import {
	useIsMutating,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ui/components/collapsible";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Label } from "@ui/components/label";
import { RadioGroup, RadioGroupItem } from "@ui/components/radio-group";
import { AlertTriangleIcon, ChevronDownIcon } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

type Step = { kind: "pick" } | { kind: "preview"; batchId: string };

/** Shared by the removal and the dialog's close guard. */
function removeBatchMutationKey(projectId: string) {
	return ["projects.aiRecommended.removeBatch", projectId];
}

interface NoEligibleCounts {
	protectedCount: number;
	requestedCount: number;
	ineligibleCount: number;
}

type RemoveResult = Awaited<
	ReturnType<typeof orpcClient.projects.aiRecommended.removeBatch>
>;

interface PreviewItem {
	id: string;
	identifier: string;
	title: string;
}

/** The counts a `NO_ELIGIBLE_ITEMS` refusal carries, or null for any other error. */
function noEligibleCounts(error: unknown): NoEligibleCounts | null {
	if (!(error instanceof ORPCError) || error.code !== "PRECONDITION_FAILED") {
		return null;
	}
	const data = error.data as
		| {
				reason?: string;
				protectedCount?: number;
				alreadyRequestedCount?: number;
				ineligibleCount?: number;
		  }
		| undefined;
	if (data?.reason !== "NO_ELIGIBLE_ITEMS") {
		return null;
	}
	return {
		protectedCount: data.protectedCount ?? 0,
		requestedCount: data.alreadyRequestedCount ?? 0,
		ineligibleCount: data.ineligibleCount ?? 0,
	};
}

function ItemList({ items }: { items: PreviewItem[] }) {
	return (
		<ul className="max-h-40 space-y-1 overflow-y-auto rounded-md border bg-muted/30 p-2 text-sm">
			{items.map((item) => (
				<li key={item.id} className="flex gap-2">
					<span className="shrink-0 font-mono text-muted-foreground text-xs leading-5">
						{item.identifier}
					</span>
					<span className="min-w-0 truncate">{item.title}</span>
				</li>
			))}
		</ul>
	);
}

function BatchPicker({
	projectId,
	onNext,
	onCancel,
}: {
	projectId: string;
	onNext: (batchId: string) => void;
	onCancel: () => void;
}) {
	const t = useTranslations("projects.stories.aiRecommended.removeDialog");
	const tGates = useTranslations("projects.capabilityGates");
	const format = useFormatter();
	const [picked, setPicked] = useState<string | null>(null);
	const { data, isLoading, isError } = useQuery(
		orpc.projects.aiRecommended.listBatches.queryOptions({
			input: { projectId },
		}),
	);
	const batches = data?.batches ?? [];
	const selected = picked ?? batches[0]?.batchId ?? null;

	let body: ReactNode;
	if (isLoading) {
		body = <p className="text-muted-foreground text-sm">{t("loading")}</p>;
	} else if (isError) {
		body = <p className="text-destructive text-sm">{t("loadError")}</p>;
	} else if (batches.length === 0) {
		body = (
			<div className="space-y-1 text-sm">
				<p className="font-medium">
					{tGates("reason.roadmap.no-eligible-ai-batch.title")}
				</p>
				<p className="text-muted-foreground">
					{tGates("reason.roadmap.no-eligible-ai-batch.body")}
				</p>
			</div>
		);
	} else {
		body = (
			<RadioGroup
				value={selected ?? undefined}
				onValueChange={setPicked}
				className="max-h-72 overflow-y-auto"
			>
				{batches.map((batch) => {
					const id = `ai-batch-${batch.batchId}`;
					const details = [
						batch.protectedCount > 0 &&
							t("batchProtected", {
								count: batch.protectedCount,
							}),
						batch.editedEligibleCount > 0 &&
							t("batchEdited", {
								count: batch.editedEligibleCount,
							}),
						batch.awaitingApprovalCount > 0 &&
							t("batchAwaiting", {
								count: batch.awaitingApprovalCount,
							}),
					].filter(Boolean);
					return (
						<div
							key={batch.batchId}
							className="flex items-start gap-3 rounded-md border p-3"
						>
							<RadioGroupItem
								id={id}
								value={batch.batchId}
								className="mt-0.5"
							/>
							<Label htmlFor={id} className="flex flex-col gap-1">
								<span>
									{t("batchLabel", {
										date: format.dateTime(
											new Date(batch.createdAt),
											{ dateStyle: "medium" },
										),
										count: batch.eligibleCount,
									})}
								</span>
								{details.length > 0 && (
									<span className="font-normal text-muted-foreground text-xs">
										{details.join(" · ")}
									</span>
								)}
							</Label>
						</div>
					);
				})}
			</RadioGroup>
		);
	}

	return (
		<>
			<DialogDescription>{t("pickDescription")}</DialogDescription>
			{body}
			<DialogFooter>
				<Button variant="outline" onClick={onCancel}>
					{t("cancel")}
				</Button>
				<Button
					disabled={selected === null}
					onClick={() => selected && onNext(selected)}
				>
					{t("next")}
				</Button>
			</DialogFooter>
		</>
	);
}

function RemovalResult({
	result,
	noEligible,
}: {
	result: RemoveResult | undefined;
	noEligible: NoEligibleCounts | null;
}) {
	const t = useTranslations("projects.stories.aiRecommended.removeDialog");
	if (noEligible) {
		return (
			<DialogDescription className="text-foreground">
				{t("noEligible", { ...noEligible })}
			</DialogDescription>
		);
	}
	if (!result) {
		return null;
	}
	const { counts } = result;
	const failed = result.results.filter((item) => item.outcome === "failed");
	return (
		<div className="space-y-2 text-sm">
			<DialogDescription className="font-medium text-foreground">
				{t("resultTitle")}
			</DialogDescription>
			<p>
				{t("resultSummary", {
					moved: counts.moved,
					requested: counts.requested,
					skipped:
						counts.skippedProtected +
						counts.skippedIneligible +
						counts.alreadyRequested,
					failed: counts.failed,
				})}
			</p>
			{counts.notPreviewed > 0 && (
				<p className="text-muted-foreground">
					{t("notPreviewed", { count: counts.notPreviewed })}
				</p>
			)}
			{failed.length > 0 && (
				<div className="space-y-1">
					<p>{t("failedHeading")}</p>
					<ul className="max-h-32 space-y-1 overflow-y-auto text-xs">
						{failed.map((item) => (
							<li key={item.storyId}>
								<span className="font-mono">
									{item.identifier ?? item.storyId}
								</span>
								{item.error ? ` — ${item.error}` : null}
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}

function BatchPreview({
	projectId,
	batchId,
	onBack,
	onClose,
}: {
	projectId: string;
	batchId: string;
	onBack: () => void;
	onClose: () => void;
}) {
	const t = useTranslations("projects.stories.aiRecommended.removeDialog");
	const queryClient = useQueryClient();
	const { data, isLoading, isError } = useQuery(
		orpc.projects.aiRecommended.previewBatch.queryOptions({
			input: { projectId, batchId },
		}),
	);

	const closeRef = useRef<HTMLButtonElement>(null);

	const removal = useMutation({
		mutationKey: removeBatchMutationKey(projectId),
		mutationFn: (expectedStoryIds: string[]) =>
			orpcClient.projects.aiRecommended.removeBatch({
				projectId,
				batchId,
				expectedStoryIds,
			}),
		onError: (error) => {
			if (noEligibleCounts(error) === null) {
				toast.error(t("error"), { description: error.message });
			}
		},
		onSettled: () => {
			for (const queryKey of [
				orpc.projects.stories.list.key(),
				orpc.projects.stories.get.key(),
				orpc.projects.aiRecommended.listBatches.key(),
				orpc.projects.aiRecommended.previewBatch.key(),
				["capability-gates", projectId],
			]) {
				void queryClient.invalidateQueries({ queryKey });
			}
		},
	});

	const refusal = removal.isError ? noEligibleCounts(removal.error) : null;
	const finished = removal.isSuccess || refusal !== null;

	// The confirm button unmounts when the removal finishes; hand focus to
	// Close rather than let it drop to the page.
	useEffect(() => {
		if (finished) {
			closeRef.current?.focus();
		}
	}, [finished]);

	if (isLoading) {
		return <DialogDescription>{t("previewLoading")}</DialogDescription>;
	}
	if (isError || !data) {
		return (
			<DialogDescription className="text-destructive">
				{t("loadError")}
			</DialogDescription>
		);
	}

	const eligible = data.eligible;
	// Nothing previewed is eligible: the door refuses an empty list, so
	// explain from the preview's own counts instead of calling it.
	const emptyPreview: NoEligibleCounts | null =
		eligible.length === 0
			? {
					protectedCount: data.protected.length,
					requestedCount: data.awaitingApproval.length,
					ineligibleCount: 0,
				}
			: null;

	return (
		<>
			{!finished && (
				<div className="space-y-3 text-sm">
					{emptyPreview ? (
						<DialogDescription className="text-foreground">
							{t("noEligiblePreview", { ...emptyPreview })}
						</DialogDescription>
					) : (
						<>
							<DialogDescription className="text-foreground">
								{t("previewDescription")}
							</DialogDescription>
							<ul className="max-h-60 space-y-1 overflow-y-auto rounded-md border bg-muted/30 p-2">
								{eligible.map((item) => (
									<li
										key={item.id}
										className="flex items-center gap-2"
									>
										<span className="shrink-0 font-mono text-muted-foreground text-xs">
											{item.identifier}
										</span>
										<span className="min-w-0 truncate">
											{item.title}
										</span>
										{item.edited && (
											<Badge
												status="warning"
												className="ml-auto shrink-0"
											>
												{t("editedBadge")}
											</Badge>
										)}
									</li>
								))}
							</ul>
						</>
					)}
					{data.protected.length > 0 && (
						<Collapsible>
							<div className="flex items-center justify-between gap-2">
								<p>
									{t("protectedSkipped", {
										count: data.protected.length,
									})}
								</p>
								<CollapsibleTrigger asChild>
									<Button variant="ghost" size="sm">
										{t("showProtected")}
										<ChevronDownIcon
											aria-hidden
											className="ml-1 size-4"
										/>
									</Button>
								</CollapsibleTrigger>
							</div>
							<CollapsibleContent className="pt-2">
								<ItemList items={data.protected} />
							</CollapsibleContent>
						</Collapsible>
					)}
					{data.awaitingApproval.length > 0 && (
						<p>
							{t("awaitingApproval", {
								count: data.awaitingApproval.length,
							})}
						</p>
					)}
					{data.editedEligibleCount > 0 && (
						<div
							role="alert"
							className="flex items-start gap-2 rounded-md border border-highlight/40 bg-highlight/10 p-3 text-highlight"
						>
							<AlertTriangleIcon
								aria-hidden
								className="mt-0.5 size-4 shrink-0"
							/>
							<p className="text-foreground">
								<span className="font-medium">
									{t("editedWarningPrefix")}
								</span>{" "}
								{t("editedWarning", {
									count: data.editedEligibleCount,
								})}
							</p>
						</div>
					)}
					{data.governedReview && (
						<p className="text-muted-foreground">
							{t("governedNotice")}
						</p>
					)}
					<p className="text-muted-foreground">
						{t("hiddenNotDeleted")}
					</p>
				</div>
			)}
			<div aria-live="polite">
				{finished && (
					<RemovalResult result={removal.data} noEligible={refusal} />
				)}
			</div>
			<DialogFooter>
				{finished ? (
					<Button ref={closeRef} onClick={onClose}>
						{t("close")}
					</Button>
				) : (
					<>
						<Button
							variant="outline"
							onClick={onBack}
							disabled={removal.isPending}
						>
							{t("back")}
						</Button>
						<Button
							variant="outline"
							onClick={onClose}
							disabled={removal.isPending}
						>
							{t("cancel")}
						</Button>
						<Button
							variant="destructive"
							disabled={
								eligible.length === 0 || removal.isPending
							}
							onClick={() =>
								removal.mutate(eligible.map((item) => item.id))
							}
						>
							{removal.isPending
								? t("confirming")
								: t(
										data.governedReview
											? "confirmGoverned"
											: "confirm",
										{ count: eligible.length },
									)}
						</Button>
					</>
				)}
			</DialogFooter>
		</>
	);
}

export function RemoveAiBatchDialog({
	projectId,
	onClose,
}: {
	projectId: string;
	onClose: () => void;
}) {
	const t = useTranslations("projects.stories.aiRecommended.removeDialog");
	const [step, setStep] = useState<Step>({ kind: "pick" });
	const titleRef = useRef<HTMLHeadingElement>(null);
	const shownStepRef = useRef(step);
	// Closing mid-removal would lose the itemized result while the server
	// work carries on, so Esc, the overlay and the X wait for it.
	const removing =
		useIsMutating({ mutationKey: removeBatchMutationKey(projectId) }) > 0;

	// Each step replaces the control that had focus. Radix places the first
	// focus on open; every later step lands on the heading.
	useEffect(() => {
		if (shownStepRef.current === step) {
			return;
		}
		shownStepRef.current = step;
		titleRef.current?.focus();
	}, [step]);

	return (
		<Dialog open onOpenChange={(open) => !open && !removing && onClose()}>
			<DialogContent className="sm:max-w-lg [&>*]:min-w-0">
				<DialogHeader>
					<DialogTitle
						ref={titleRef}
						tabIndex={-1}
						className="focus:outline-none"
					>
						{t("title")}
					</DialogTitle>
				</DialogHeader>
				{step.kind === "pick" ? (
					<BatchPicker
						projectId={projectId}
						onCancel={onClose}
						onNext={(batchId) =>
							setStep({ kind: "preview", batchId })
						}
					/>
				) : (
					<BatchPreview
						projectId={projectId}
						batchId={step.batchId}
						onBack={() => setStep({ kind: "pick" })}
						onClose={onClose}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}
