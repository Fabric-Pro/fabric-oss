"use client";

/**
 * The recurring-error scan's tunables: how often an error must recur, within
 * how many hours, and how confident the judge must be that two errors (or an
 * error and an open bug) are the same problem before they are grouped.
 *
 * Saved explicitly, like the log source below it: three numbers edited
 * together are not worth a request per keystroke. Written through
 * `projects.update`, which bounds each value and keeps the edit admin-only.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { Loader2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";

/** The bounds `projects.update` enforces. */
const THRESHOLD = { min: 2, max: 1000 };
const WINDOW_HOURS = { min: 1, max: 168 };
const SIMILARITY = { min: 0.5, max: 1 };

type Tuning = {
	recurringErrorThreshold: number;
	recurringErrorWindowHours: number;
	recurringErrorSimilarityThreshold: number;
};

function inRange(
	value: number,
	{ min, max }: { min: number; max: number },
): boolean {
	return Number.isFinite(value) && value >= min && value <= max;
}

export function ProjectRecurringErrorTuning({
	project,
	canEdit,
}: {
	project: {
		id: string;
		organizationId?: string | null;
		recurringErrorThreshold?: number | null;
		recurringErrorWindowHours?: number | null;
		recurringErrorSimilarityThreshold?: number | null;
	};
	canEdit: boolean;
}) {
	const t = useTranslations("projects.recurringErrors.tuning");
	const queryClient = useQueryClient();
	const projectId = project.id;
	const organizationId = project.organizationId ?? null;
	const stored: Tuning = {
		recurringErrorThreshold: project.recurringErrorThreshold ?? 5,
		recurringErrorWindowHours: project.recurringErrorWindowHours ?? 24,
		recurringErrorSimilarityThreshold:
			project.recurringErrorSimilarityThreshold ?? 0.7,
	};
	const [threshold, setThreshold] = useState(
		String(stored.recurringErrorThreshold),
	);
	const [windowHours, setWindowHours] = useState(
		String(stored.recurringErrorWindowHours),
	);
	const [similarity, setSimilarity] = useState(
		String(stored.recurringErrorSimilarityThreshold),
	);

	// Re-seed from the server whenever the project reloads.
	useEffect(() => {
		setThreshold(String(stored.recurringErrorThreshold));
		setWindowHours(String(stored.recurringErrorWindowHours));
		setSimilarity(String(stored.recurringErrorSimilarityThreshold));
	}, [
		stored.recurringErrorThreshold,
		stored.recurringErrorWindowHours,
		stored.recurringErrorSimilarityThreshold,
	]);

	const mutation = useMutation({
		mutationFn: async (tuning: Tuning) =>
			orpcClient.projects.update({
				id: projectId,
				organizationId,
				...tuning,
			}),
		onSuccess: () => {
			toast.success(t("saved"));
			queryClient.invalidateQueries({
				queryKey: orpc.projects.get.queryKey({
					input: { id: projectId, organizationId },
				}),
			});
		},
		onError: (error) =>
			toast.error(
				error instanceof Error ? error.message : t("saveFailed"),
			),
	});

	const draft: Tuning = {
		recurringErrorThreshold: Number(threshold),
		recurringErrorWindowHours: Number(windowHours),
		recurringErrorSimilarityThreshold: Number(similarity),
	};
	const thresholdValid =
		Number.isInteger(draft.recurringErrorThreshold) &&
		inRange(draft.recurringErrorThreshold, THRESHOLD);
	const windowValid =
		Number.isInteger(draft.recurringErrorWindowHours) &&
		inRange(draft.recurringErrorWindowHours, WINDOW_HOURS);
	const similarityValid = inRange(
		draft.recurringErrorSimilarityThreshold,
		SIMILARITY,
	);
	const unchanged =
		draft.recurringErrorThreshold === stored.recurringErrorThreshold &&
		draft.recurringErrorWindowHours === stored.recurringErrorWindowHours &&
		draft.recurringErrorSimilarityThreshold ===
			stored.recurringErrorSimilarityThreshold;
	const disabled = !canEdit || mutation.isPending;

	return (
		<div className="space-y-3 border-t pt-4">
			<div className="space-y-1">
				<p className="font-medium text-sm">{t("title")}</p>
				<p className="text-muted-foreground text-xs">
					{t("description")}
				</p>
			</div>

			{/* Wraps by the card's width, not the viewport's: the card is narrow. */}
			<div className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-3">
				<div className="space-y-1">
					<Label htmlFor="qa-recurring-threshold">
						{t("thresholdLabel")}
					</Label>
					<Input
						id="qa-recurring-threshold"
						type="number"
						inputMode="numeric"
						min={THRESHOLD.min}
						max={THRESHOLD.max}
						step={1}
						value={threshold}
						onChange={(e) => setThreshold(e.target.value)}
						disabled={disabled}
						aria-invalid={!thresholdValid}
					/>
				</div>
				<div className="space-y-1">
					<Label htmlFor="qa-recurring-window">
						{t("windowLabel")}
					</Label>
					<Input
						id="qa-recurring-window"
						type="number"
						inputMode="numeric"
						min={WINDOW_HOURS.min}
						max={WINDOW_HOURS.max}
						step={1}
						value={windowHours}
						onChange={(e) => setWindowHours(e.target.value)}
						disabled={disabled}
						aria-invalid={!windowValid}
					/>
				</div>
				<div className="space-y-1">
					<Label htmlFor="qa-recurring-similarity">
						{t("similarityLabel")}
					</Label>
					<Input
						id="qa-recurring-similarity"
						type="number"
						inputMode="decimal"
						min={SIMILARITY.min}
						max={SIMILARITY.max}
						step={0.05}
						value={similarity}
						onChange={(e) => setSimilarity(e.target.value)}
						disabled={disabled}
						aria-invalid={!similarityValid}
						aria-describedby="qa-recurring-similarity-help"
					/>
				</div>
			</div>
			<p
				id="qa-recurring-similarity-help"
				className="text-muted-foreground text-xs"
			>
				{t("similarityHelp")}
			</p>
			{!(thresholdValid && windowValid && similarityValid) && (
				<p className="text-destructive text-xs">
					{t("invalid", {
						thresholdMin: THRESHOLD.min,
						thresholdMax: THRESHOLD.max,
						windowMax: WINDOW_HOURS.max,
						similarityMin: SIMILARITY.min,
					})}
				</p>
			)}

			<Button
				size="sm"
				onClick={() => mutation.mutate(draft)}
				disabled={
					disabled ||
					unchanged ||
					!(thresholdValid && windowValid && similarityValid)
				}
			>
				{mutation.isPending && (
					<Loader2Icon
						className="mr-1.5 size-3.5 motion-safe:animate-spin"
						aria-hidden="true"
					/>
				)}
				{t("saveThresholds")}
			</Button>
		</div>
	);
}
