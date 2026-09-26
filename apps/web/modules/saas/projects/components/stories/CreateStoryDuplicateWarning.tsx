"use client";

/**
 * Duplicate-detection warning step for the roadmap "Add" dialog's manual
 * create (Fizzy #2180) — NOT the feature-proposal review flow, which already
 * has `ProposalRoutingControl`. Rendered in place of the create form's body
 * inside `CreateStoryDialog` (`StoriesRoadmap.tsx`) when `checkDuplicate`
 * comes back with an "enrich" decision; form state (description, priority,
 * attachments) is kept by the parent so "Back" returns to it intact.
 *
 * Reuses `confidenceBand` from `ProposalRoutingControl.tsx` (exported for
 * exactly this) and `ProposalDiffField` for the merge preview, so the two
 * surfaces read as one system rather than two independent designs of the
 * same idea.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import { Label } from "@ui/components/label";
import { RadioGroup, RadioGroupItem } from "@ui/components/radio-group";
import { cn } from "@ui/lib";
import { AlertTriangleIcon, ExternalLinkIcon, Loader2Icon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast as sonnerToast } from "sonner";
import { buildStoryDetailsRoute } from "../../lib/stories/routes";
import {
	type SubmitEnrichStoryDeps,
	submitCreateStoryEnrichment,
} from "../../lib/submit-create-story-enrichment";
import type { PendingDocAttachment } from "../../lib/text-attachment-validation";
import { ProposalDiffField } from "./ProposalDiffField";
import { confidenceBand } from "./ProposalRoutingControl";

/** `submitCreateStoryEnrichment` takes a `toast` dep rather than importing
 * `sonner` directly, matching `submitCreateStoryWithAttachments`. */
const uiToast = {
	success: (m: string) => sonnerToast.success(m),
	error: (m: string) => sonnerToast.error(m),
	warning: (m: string) => sonnerToast.warning(m),
};

type CheckDuplicateAlternative = {
	storyId: string;
	identifier: string;
	title: string;
	similarity: number;
};

/** The full wire shape of `projects.stories.checkDuplicate`'s response. */
export type CheckDuplicateResult = {
	decision: "create" | "enrich";
	confidence: number;
	matchedStoryId?: string;
	matchedIdentifier?: string;
	matchedTitle?: string;
	reasoning?: string | null;
	alternatives: CheckDuplicateAlternative[];
	error?: string;
};

/** The subset of `checkDuplicate`'s response this step renders — always the
 * "enrich" decision; a "create" or an error result never reaches this
 * component (the dialog stays on the form). */
export type DuplicateWarningResult = {
	decision: "enrich";
	confidence: number;
	matchedStoryId: string;
	matchedIdentifier?: string;
	matchedTitle?: string;
	reasoning?: string | null;
	alternatives: CheckDuplicateAlternative[];
};

export type CheckBeforeCreateOutcome =
	| { kind: "warn"; result: DuplicateWarningResult }
	| { kind: "create"; checkFailed: boolean };

/**
 * Turns one `checkDuplicate` call into what the create dialog's submit
 * handler needs: either a warning to show, or a signal to proceed with
 * creation and whether the check itself is why. A rejected call and an
 * `error`-carrying result both mean "could not check" (`checkFailed: true`);
 * an enrich decision missing its target degrades to a plain create rather
 * than a warning with nothing to show.
 */
export async function checkBeforeCreate(
	run: () => Promise<CheckDuplicateResult>,
): Promise<CheckBeforeCreateOutcome> {
	let result: CheckDuplicateResult;
	try {
		result = await run();
	} catch {
		return { kind: "create", checkFailed: true };
	}
	if (result.error) {
		return { kind: "create", checkFailed: true };
	}
	if (result.decision === "enrich" && result.matchedStoryId) {
		return {
			kind: "warn",
			result: {
				decision: result.decision,
				confidence: result.confidence,
				matchedStoryId: result.matchedStoryId,
				matchedIdentifier: result.matchedIdentifier,
				matchedTitle: result.matchedTitle,
				reasoning: result.reasoning,
				alternatives: result.alternatives,
			},
		};
	}
	return { kind: "create", checkFailed: false };
}

type Props = {
	result: DuplicateWarningResult;
	projectId: string;
	organizationId: string | null;
	basePath: string;
	/** The draft description as typed, used as the merge's proposed text. */
	description: string;
	files: File[];
	docAttachments: PendingDocAttachment[];
	deps: Pick<
		SubmitEnrichStoryDeps,
		"uploadStoryImage" | "uploadStoryAttachment" | "updateStoryMutateAsync"
	>;
	/** Returns to the create form, state intact. */
	onBack: () => void;
	/** Proceeds with creating a new item. */
	onCreateAnyway: () => void;
	/** The target was updated; the parent invalidates its stories query,
	 * closes the dialog and navigates. */
	onEnriched: (storyId: string) => void;
};

export function CreateStoryDuplicateWarning({
	result,
	projectId,
	organizationId,
	basePath,
	description,
	files,
	docAttachments,
	deps,
	onBack,
	onCreateAnyway,
	onEnriched,
}: Props) {
	const t = useTranslations("projects.stories.create.duplicateWarning");
	const { alternatives } = result;
	const [selectedStoryId, setSelectedStoryId] = useState(
		result.matchedStoryId ?? alternatives[0]?.storyId,
	);
	const selected =
		alternatives.find((alt) => alt.storyId === selectedStoryId) ??
		alternatives[0];

	// Moves focus into the step as it appears, so a screen-reader user is told
	// about the warning rather than left on a control that just vanished.
	const containerRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		containerRef.current?.focus();
	}, []);

	const previewMutation = useMutation({
		mutationFn: (targetStoryId: string) =>
			orpcClient.projects.stories.previewEnrichment({
				projectId,
				organizationId,
				targetStoryId,
				proposedDescription: description,
				reasoning: result.reasoning ?? undefined,
			}),
	});
	const preview = previewMutation.data;
	const hasAttachments = files.length > 0 || docAttachments.length > 0;
	// A fallback merge changes nothing on the target; without an attachment to
	// carry over there is nothing left for "Update" to write.
	const fallbackWithNothingToAdd = !!preview?.fallbackUsed && !hasAttachments;

	const confirmMutation = useMutation({
		mutationFn: async () => {
			if (!selected || !preview) {
				throw new Error("Nothing to update yet.");
			}
			return await submitCreateStoryEnrichment({
				projectId,
				targetStoryId: selected.storyId,
				targetIdentifier: selected.identifier,
				mergedDescription: preview.mergedDescription,
				mergedAcceptanceCriteria: preview.mergedAcceptanceCriteria,
				acceptanceCriteriaChanged:
					preview.currentAcceptanceCriteria !==
					preview.mergedAcceptanceCriteria,
				files,
				docAttachments,
				organizationId,
				deps: { ...deps, toast: uiToast },
			});
		},
		onSuccess: (r) => onEnriched(r.storyId),
	});

	if (!selected) {
		// Defensive: an "enrich" decision always names a target among its own
		// alternatives.
		return null;
	}

	const band = confidenceBand(result.confidence);

	return (
		<div
			ref={containerRef}
			tabIndex={-1}
			className="space-y-4 outline-none"
		>
			<Alert variant="warning">
				<AlertTriangleIcon aria-hidden="true" />
				<AlertTitle>{t("title")}</AlertTitle>
				<AlertDescription className="space-y-2">
					<p>{t("body")}</p>
					<p className={cn("text-xs", band.className)}>
						{band.label}
					</p>
					{result.reasoning && (
						<p className="text-muted-foreground text-xs">
							{result.reasoning}
						</p>
					)}
				</AlertDescription>
			</Alert>

			{alternatives.length > 1 ? (
				<fieldset className="space-y-2">
					<legend className="text-sm font-medium">
						{t("whichItem")}
					</legend>
					<RadioGroup
						value={selectedStoryId}
						onValueChange={(value) => {
							setSelectedStoryId(value);
							previewMutation.reset();
						}}
						className="gap-1.5"
					>
						{alternatives.map((alt) => (
							<div
								key={alt.storyId}
								className="flex items-center gap-2 rounded-md border p-2 text-sm"
							>
								<RadioGroupItem
									value={alt.storyId}
									id={`duplicate-target-${alt.storyId}`}
								/>
								<Label
									htmlFor={`duplicate-target-${alt.storyId}`}
									className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 font-normal"
								>
									<span className="shrink-0 font-mono text-muted-foreground text-xs">
										{alt.identifier}
									</span>
									<span className="min-w-0 flex-1 truncate">
										{alt.title}
									</span>
								</Label>
							</div>
						))}
					</RadioGroup>
				</fieldset>
			) : (
				<p className="flex items-center gap-2 text-sm">
					<span className="shrink-0 font-mono text-muted-foreground text-xs">
						{selected.identifier}
					</span>
					<span className="min-w-0 truncate">{selected.title}</span>
				</p>
			)}

			<Link
				href={buildStoryDetailsRoute(
					basePath,
					projectId,
					selected.storyId,
				)}
				target="_blank"
				rel="noreferrer"
				className="inline-flex items-center gap-1 text-primary text-sm underline underline-offset-2"
			>
				{t("openInNewTab", { identifier: selected.identifier })}
				<ExternalLinkIcon aria-hidden="true" className="size-3.5" />
			</Link>

			{/* Only the short status lines are announced; the diff below is
			    read on its own terms rather than as one long live-region
			    utterance. */}
			<output aria-live="polite" className="block min-h-4">
				{previewMutation.isPending && (
					<p className="text-muted-foreground text-xs">
						{t("workingOutChange", {
							identifier: selected.identifier,
						})}
					</p>
				)}
				{previewMutation.isError && (
					<p className="text-destructive text-xs">
						{t("previewError")}
					</p>
				)}
				{preview?.targetClosed && (
					<p className="text-amber-700 text-xs dark:text-highlight">
						{t("targetClosed", {
							identifier: preview.targetIdentifier,
						})}
					</p>
				)}
				{preview?.fallbackUsed && (
					<p className="text-muted-foreground text-xs">
						{fallbackWithNothingToAdd
							? t("fallbackUsedNothingToAdd", {
									identifier: preview.targetIdentifier,
								})
							: t("fallbackUsed", {
									identifier: preview.targetIdentifier,
								})}
					</p>
				)}
				{confirmMutation.isError && (
					<p className="text-destructive text-xs">
						{t("updateError")}
					</p>
				)}
			</output>

			{preview && !preview.fallbackUsed && (
				<div className="space-y-1">
					{preview.currentDescription !==
						preview.mergedDescription && (
						<ProposalDiffField
							label={t("descriptionLabel")}
							from={preview.currentDescription}
							to={preview.mergedDescription}
						/>
					)}
					{preview.currentAcceptanceCriteria !==
						preview.mergedAcceptanceCriteria && (
						<ProposalDiffField
							label={t("acceptanceCriteriaLabel")}
							from={preview.currentAcceptanceCriteria}
							to={preview.mergedAcceptanceCriteria}
						/>
					)}
				</div>
			)}

			<div className="flex flex-wrap justify-end gap-2">
				<Button type="button" variant="ghost" onClick={onBack}>
					{t("back")}
				</Button>
				<Button
					type="button"
					variant="outline"
					onClick={onCreateAnyway}
				>
					{t("createAnyway")}
				</Button>
				{preview ? (
					<Button
						type="button"
						disabled={
							confirmMutation.isPending ||
							fallbackWithNothingToAdd
						}
						onClick={() => confirmMutation.mutate()}
					>
						{confirmMutation.isPending && (
							<Loader2Icon
								aria-hidden="true"
								className="mr-2 size-4 motion-safe:animate-spin"
							/>
						)}
						{t("updateTo", { identifier: selected.identifier })}
					</Button>
				) : (
					<Button
						type="button"
						disabled={previewMutation.isPending}
						onClick={() => previewMutation.mutate(selected.storyId)}
					>
						{previewMutation.isPending && (
							<Loader2Icon
								aria-hidden="true"
								className="mr-2 size-4 motion-safe:animate-spin"
							/>
						)}
						{t("addTo", { identifier: selected.identifier })}
					</Button>
				)}
			</div>
		</div>
	);
}
