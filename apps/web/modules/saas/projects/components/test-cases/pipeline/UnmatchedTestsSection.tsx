"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { cn } from "@ui/lib";
import { CheckIcon, Loader2Icon, PlusIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { RESULT_TONE, type TestResult, TONE_CLASSES } from "../constants";

/** Distinct unmatched tests rendered before "show more". */
const PAGE = 15;

type UnmatchedTest = {
	name: string;
	classname: string | null;
	occurrences: number;
	lastStatus: TestResult;
	lastSeenAt: string | Date | null;
	provider: string;
};

/**
 * Automated tests CI is running that map to no Fabric test case — coverage the
 * project HAS but isn't tracking.
 *
 * Ingestion counts these and moves on, which is why a suite of hundreds of
 * automated tests can sit next to a "no coverage" reading. Creating a case from
 * a row seeds the automation ref with the test's own name/classname, so the
 * linkage cascade claims it on the next sync and the row disappears on its own
 * — the list is a work queue that drains, not a permanent report.
 */
export function UnmatchedTestsSection({
	projectId,
	organizationId,
	className,
}: {
	projectId: string;
	organizationId: string | null;
	className?: string;
}) {
	const t = useTranslations("projects.stories.maturation.qa.unmatchedTests");
	const queryClient = useQueryClient();
	const [limit, setLimit] = useState(PAGE);
	const [creating, setCreating] = useState<string | null>(null);
	// A created row can't leave the list until the next sync re-links it, so
	// without this the button stays live and a second click silently files a
	// duplicate case for the same test.
	const [createdKeys, setCreatedKeys] = useState<Set<string>>(new Set());

	const query = useQuery(
		orpc.projects.pipelineResults.unmatchedTests.queryOptions({
			input: { projectId },
		}),
	);

	const createMutation = useMutation(
		orpc.projects.testCases.create.mutationOptions({
			onSuccess: (_data, variables) => {
				// Keyed off the request itself, not the `creating` state, so the
				// mark lands on the right row even if another click raced it.
				setCreatedKeys((prev) =>
					new Set(prev).add(
						`${variables.automationFilePath ?? ""}::${variables.automationRef}`,
					),
				);
				toast.success(t("created"));
				queryClient.invalidateQueries({
					queryKey: orpc.projects.testCases.list.key(),
				});
				// The row stays until the next sync re-links it; refresh anyway so
				// counts stay honest if the user syncs immediately.
				queryClient.invalidateQueries({
					queryKey:
						orpc.projects.pipelineResults.unmatchedTests.key(),
				});
			},
			onError: (error) => toast.error(error.message),
			onSettled: () => setCreating(null),
		}),
	);

	const tests = (query.data?.tests ?? []) as UnmatchedTest[];
	const totalDistinct = query.data?.totalDistinct ?? 0;

	// Nothing unmatched is the good outcome — say nothing rather than render an
	// empty panel that reads like a problem.
	//
	// A FAILED load is also silent, and deliberately so: this is a supplementary
	// triage list, and the alternative was worse. The guard used to let an error
	// fall through to the render below, which printed the heading and
	// "0 tests across 0 runs" — an authoritative "nothing is untracked" claim
	// built from a query that never answered.
	if (query.isLoading || query.isError || tests.length === 0) {
		return null;
	}

	const visible = tests.slice(0, limit);

	return (
		<section
			aria-labelledby="qa-unmatched-tests"
			data-onboarding-target="test-cases-untracked"
			className={cn("space-y-2", className)}
		>
			<div className="flex items-center justify-between gap-2">
				<h2
					id="qa-unmatched-tests"
					className="font-medium text-[11px] text-muted-foreground uppercase tracking-[0.2em]"
				>
					{t("title")}
				</h2>
				<span className="text-muted-foreground text-xs">
					{t("count", {
						count: totalDistinct,
						runs: query.data?.scannedRuns ?? 0,
					})}
					{/*
					 * `totalDistinct` is counted BEFORE the server's cap, so a
					 * large backlog advertised a number the list could never
					 * reach — "250 untracked" above a list that exhausts at 100,
					 * with the other 150 unreachable and unmentioned. Say so.
					 */}
					{totalDistinct > tests.length
						? ` · ${t("countCapped", {
								shown: tests.length,
								count: totalDistinct,
							})}`
						: null}
				</span>
			</div>
			<p className="text-muted-foreground text-xs">{t("hint")}</p>

			<ul className="divide-y divide-border rounded-md border border-border">
				{visible.map((test) => {
					const key = `${test.classname ?? ""}::${test.name}`;
					const tone = TONE_CLASSES[RESULT_TONE[test.lastStatus]];
					return (
						<li
							key={key}
							className="flex items-center justify-between gap-3 px-3 py-2.5"
						>
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-2">
									<span
										aria-hidden="true"
										className={cn(
											"size-1.5 shrink-0 rounded-full",
											tone.dot,
										)}
									/>
									<span className="truncate font-medium text-sm">
										{test.name}
									</span>
								</div>
								{test.classname && (
									<p className="truncate pl-3.5 font-mono text-[11px] text-muted-foreground">
										{test.classname}
									</p>
								)}
							</div>
							{createdKeys.has(key) ? (
								<span className="inline-flex shrink-0 items-center gap-1.5 text-secondary text-xs">
									<CheckIcon
										className="size-3.5"
										aria-hidden="true"
									/>
									{t("caseCreated")}
								</span>
							) : (
								<Button
									type="button"
									size="sm"
									variant="outline"
									className="shrink-0 gap-1.5"
									disabled={createMutation.isPending}
									onClick={() => {
										setCreating(key);
										createMutation.mutate({
											projectId,
											organizationId,
											title: test.name,
											// Seed automation so the cascade claims this
											// test next sync instead of re-listing it.
											automationStatus: "AUTOMATED",
											automationRef: test.name,
											automationFilePath:
												test.classname ?? undefined,
										});
									}}
								>
									{createMutation.isPending &&
									creating === key ? (
										<Loader2Icon
											className="size-3.5 motion-safe:animate-spin"
											aria-hidden="true"
										/>
									) : (
										<PlusIcon
											className="size-3.5"
											aria-hidden="true"
										/>
									)}
									{t("createCase")}
								</Button>
							)}
						</li>
					);
				})}
			</ul>

			{visible.length < tests.length && (
				<div className="text-center">
					<Button
						type="button"
						variant="link"
						size="sm"
						className="h-auto p-0 text-xs"
						onClick={() => setLimit((l) => l + PAGE)}
					>
						{t("showMore", {
							shown: visible.length,
							total: tests.length,
						})}
					</Button>
				</div>
			)}
		</section>
	);
}
