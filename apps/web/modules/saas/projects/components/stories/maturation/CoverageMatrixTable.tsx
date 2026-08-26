"use client";

import { criterionDisplayText } from "@repo/utils/acceptance-criteria";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { CameraIcon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import type { ParsedCriterion } from "../../../lib/stories/qa-traceability";

/** The pyramid levels a person can assign, plus the honest "not said" option. */
const COVERAGE_TYPE_OPTIONS = [
	{ value: "UNSET", label: "—" },
	{ value: "UNIT", label: "Unit" },
	{ value: "INTEGRATION", label: "Integration" },
	{ value: "E2E", label: "E2E" },
	{ value: "MANUAL", label: "Manual" },
] as const;

/** The minimum a case must carry to appear in the matrix. */
export interface MatrixCase {
	id: string;
	identifier: string;
	title: string;
	currentResult: string;
}

type Props = {
	projectId: string;
	storyId: string;
	organizationId: string | null;
	/**
	 * Criteria and the cases covering each, already grouped by the panel.
	 *
	 * Deliberately passed in rather than fetched here. The panel's own case
	 * query is what its stat strip, markdown download and Load-more all read,
	 * and fetching "which cases cover this criterion" a second time would be a
	 * second source of truth that can disagree with the first — including with
	 * the truncation notice sitting directly above this table.
	 */
	rows: Array<{ criterion: ParsedCriterion; cases: MatrixCase[] }>;
	unmappedCases: MatrixCase[];
	/**
	 * Cases that DO name a criterion but one that cannot be placed. Kept apart
	 * from `unmappedCases` because "you never mapped this" and "you mapped this
	 * and I cannot find it" need different actions — the second is usually the
	 * criterion text, not the case.
	 */
	unresolvedCases?: MatrixCase[];
	/** Criterion indices the QA analysis flagged, rendered as a warning. */
	flaggedCriteria: Set<number>;
	/** Deep-link into the QA tab for one case. */
	caseHref: (caseId: string) => string;
	/** Copy for a criterion nothing covers. */
	uncoveredLabel: string;
	unmappedLabel: string;
	criterionLabel: (index: number) => string;
};

/**
 * The traceability matrix in its richer form.
 *
 * The previous matrix could say a criterion had three cases and what fraction
 * passed. It could not say what KIND of coverage those three were, where the
 * automation lives, which commit last proved it, whether anyone captured
 * evidence, or whether the cases still match the feature they were drafted from
 * — and "three cases" means something very different when all three are manual
 * clickthroughs than when one is a unit test, one an integration test and one an
 * E2E run.
 *
 * The coverage index only ENRICHES the cases the panel already grouped. It never
 * decides which cases appear, so the matrix cannot disagree with the counts and
 * truncation notice beside it, and a slow or failed index degrades to the plain
 * matrix instead of an empty one.
 *
 * Coverage type is the only column a person fills in; everything else is derived
 * from rows that already existed and had simply never been read together.
 */
export function CoverageMatrixTable({
	projectId,
	storyId,
	organizationId,
	rows,
	unmappedCases,
	unresolvedCases = [],
	flaggedCriteria,
	caseHref,
	uncoveredLabel,
	unmappedLabel,
	criterionLabel,
}: Props) {
	const queryClient = useQueryClient();

	const indexQuery = useQuery(
		orpc.projects.testCases.coverageIndex.get.queryOptions({
			input: { projectId, storyId, organizationId },
		}),
	);

	const setType = useMutation(
		orpc.projects.testCases.coverageIndex.setType.mutationOptions({
			onSuccess: () =>
				queryClient.invalidateQueries({
					queryKey: orpc.projects.testCases.coverageIndex.get.key(),
				}),
			onError: (error) => toast.error(error.message),
		}),
	);

	const detailById = new Map(
		(indexQuery.data?.entries ?? []).map((entry) => [entry.id, entry]),
	);

	const renderCase = (testCase: MatrixCase) => {
		const detail = detailById.get(testCase.id);
		return (
			<div
				key={testCase.id}
				className="flex flex-wrap items-center gap-2 py-1 text-xs"
			>
				<Link
					href={caseHref(testCase.id)}
					title={testCase.title}
					className="shrink-0 font-mono text-foreground underline-offset-2 hover:underline"
				>
					{testCase.identifier}
				</Link>

				<span className="text-muted-foreground">
					{testCase.currentResult}
				</span>

				{detail && (
					<Select
						value={detail.coverageType ?? "UNSET"}
						onValueChange={(value) =>
							setType.mutate({
								projectId,
								testCaseId: testCase.id,
								// "—" means nobody has said. Kept assignable so a
								// wrong guess can be taken back, rather than being
								// a one-way door.
								coverageType:
									value === "UNSET"
										? null
										: (value as
												| "UNIT"
												| "INTEGRATION"
												| "E2E"
												| "MANUAL"),
								organizationId,
							})
						}
					>
						<SelectTrigger
							className="h-6 w-[7.5rem] text-xs"
							aria-label={`Coverage type for ${testCase.identifier}`}
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{COVERAGE_TYPE_OPTIONS.map((option) => (
								<SelectItem
									key={option.value}
									value={option.value}
								>
									{option.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				)}

				{detail?.specFilePath && (
					<span
						className="max-w-[16rem] truncate font-mono text-muted-foreground"
						title={detail.specFilePath}
					>
						{detail.specFilePath}
					</span>
				)}

				{detail?.commitSha && (
					<span
						className="font-mono text-muted-foreground"
						title={`Last proved by commit ${detail.commitSha}`}
					>
						{detail.commitSha.slice(0, 7)}
					</span>
				)}

				{detail && detail.evidenceCount > 0 && (
					<span
						className="inline-flex items-center gap-1 text-muted-foreground"
						title={`${detail.evidenceCount} screenshot${detail.evidenceCount === 1 ? "" : "s"} captured`}
					>
						<CameraIcon className="size-3" aria-hidden="true" />
						{detail.evidenceCount}
					</span>
				)}

				{detail?.isStale && (
					<Tooltip>
						<TooltipTrigger asChild>
							<span className="inline-flex items-center gap-1 rounded-full border border-highlight/40 bg-highlight/10 px-1.5 py-0.5 text-highlight">
								<TriangleAlertIcon
									className="size-3"
									aria-hidden="true"
								/>
								Out of date
							</span>
						</TooltipTrigger>
						<TooltipContent>
							This case was drafted from an earlier version of the
							feature. It may assert a flow the product no longer
							has.
						</TooltipContent>
					</Tooltip>
				)}
			</div>
		);
	};

	return (
		<ul className="divide-y">
			{rows.map((row) => (
				<li key={row.criterion.index} className="p-3">
					<div className="flex items-start gap-2">
						<span className="shrink-0 font-mono text-muted-foreground text-xs">
							{criterionLabel(row.criterion.index)}
						</span>
						{flaggedCriteria.has(row.criterion.index) && (
							<TriangleAlertIcon
								role="img"
								className="mt-0.5 size-3.5 shrink-0 text-highlight"
								aria-label="Flagged by the QA analysis"
							/>
						)}
						<span className="min-w-0 text-foreground text-sm [overflow-wrap:anywhere]">
							{criterionDisplayText(row.criterion.text)}
						</span>
					</div>
					<div className="mt-1 pl-6">
						{row.cases.length === 0 ? (
							<span className="text-muted-foreground text-xs italic">
								{uncoveredLabel}
							</span>
						) : (
							row.cases.map(renderCase)
						)}
					</div>
				</li>
			))}

			{unresolvedCases.length > 0 && (
				<li className="p-3">
					<span className="text-muted-foreground text-sm italic">
						Linked to a criterion that could not be found (
						{unresolvedCases.length})
					</span>
					<div className="mt-1 pl-6">
						{unresolvedCases.map(renderCase)}
					</div>
				</li>
			)}
			{unmappedCases.length > 0 && (
				<li className="p-3">
					<span className="text-muted-foreground text-sm italic">
						{unmappedLabel}
					</span>
					<div className="mt-1 pl-6">
						{unmappedCases.map(renderCase)}
					</div>
				</li>
			)}
		</ul>
	);
}
