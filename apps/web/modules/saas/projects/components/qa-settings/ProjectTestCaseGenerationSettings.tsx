"use client";

/**
 * Test-case generation policy — whether Fabric drafts cases at all, whether it
 * drafts them before implementation, and whether a failing CI test opens a bug.
 *
 * These three lived on Settings ▸ AI Assistant, which predates this page. They
 * are QA policy, so they belong beside the rest of it: someone configuring how
 * their team tests should not have to know that two of the knobs happen to be
 * columns on `Project` while the ones next to them are columns on
 * `ProjectQaSettings`.
 *
 * **Why this is a separate component from `ProjectQaSettingsForm`.** That form is
 * a single draft saved as a whole through `qaSettings.update`. These three write
 * to `Project` through `projects.update`, one toggle at a time, and they took
 * effect immediately before this move. Folding them into the whole-form save
 * would have changed when they apply — a behaviour change smuggled in under a
 * relocation. They keep their own mutations and their own instant-save
 * semantics; only their address changed.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Card } from "@ui/components/card";
import { Label } from "@ui/components/label";
import { Switch } from "@ui/components/switch";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { InfoIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

type ToggleField =
	| "generateManualTestCases"
	| "applyTddApproach"
	| "autoCreateBugsFromFailures";

/**
 * One instant-save toggle write. A real custom hook at module scope rather than
 * a closure inside the component — a hook declared in a render body is a
 * rules-of-hooks trap waiting for the first conditional caller.
 */
function useToggleMutation(input: {
	projectId: string;
	organizationId: string | null;
	field: ToggleField;
	successMessage: string;
}) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (next: boolean) =>
			orpcClient.projects.update({
				id: input.projectId,
				organizationId: input.organizationId,
				[input.field]: next,
			}),
		onSuccess: () => {
			toast.success(input.successMessage);
			queryClient.invalidateQueries({
				queryKey: orpc.projects.get.queryKey({
					input: {
						id: input.projectId,
						organizationId: input.organizationId,
					},
				}),
			});
		},
		onError: (error) =>
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to update setting",
			),
	});
}

/**
 * The three columns are declared OPTIONAL, mirroring how
 * `ProjectAiAssistantSettings` took them before the move. The shared `Project`
 * type the settings page holds does not list them even though the API returns
 * them, so a required prop would not compile at the call site. Defaults here
 * mirror the schema: generation ON, TDD ordering OFF, auto-bug OFF.
 */
export function ProjectTestCaseGenerationSettings({
	project,
	canEdit,
}: {
	project: {
		id: string;
		organizationId?: string | null;
		generateManualTestCases?: boolean | null;
		applyTddApproach?: boolean | null;
		autoCreateBugsFromFailures?: boolean | null;
	};
	canEdit: boolean;
}) {
	const projectId = project.id;
	const organizationId = project.organizationId ?? null;
	const generateManualTestCases = project.generateManualTestCases ?? true;
	const applyTddApproach = project.applyTddApproach ?? false;
	const autoCreateBugsFromFailures =
		project.autoCreateBugsFromFailures ?? false;

	const [generateManual, setGenerateManual] = useState(
		generateManualTestCases,
	);
	const [applyTdd, setApplyTdd] = useState(applyTddApproach);
	const [autoCreateBugs, setAutoCreateBugs] = useState(
		autoCreateBugsFromFailures,
	);

	// Re-seed from the server whenever the project reloads, so a save made in
	// another tab is not overwritten by this component's stale local state.
	useEffect(() => {
		setGenerateManual(generateManualTestCases);
	}, [generateManualTestCases]);
	useEffect(() => {
		setApplyTdd(applyTddApproach);
	}, [applyTddApproach]);
	useEffect(() => {
		setAutoCreateBugs(autoCreateBugsFromFailures);
	}, [autoCreateBugsFromFailures]);

	const generateManualMutation = useToggleMutation({
		projectId,
		organizationId,
		field: "generateManualTestCases",
		successMessage: "Test-case generation setting updated",
	});
	const applyTddMutation = useToggleMutation({
		projectId,
		organizationId,
		field: "applyTddApproach",
		successMessage: "TDD approach setting updated",
	});
	const autoCreateBugsMutation = useToggleMutation({
		projectId,
		organizationId,
		field: "autoCreateBugsFromFailures",
		// Copy kept verbatim from the AI Assistant page this moved off, so the
		// relocation changes the address and nothing else.
		successMessage: "Bug-on-failure setting updated",
	});

	// Optimistic toggles that revert on failure — a switch that stays flipped
	// after a rejected write tells the user the opposite of the truth.
	const handle = (
		next: boolean,
		previous: boolean,
		setLocal: (v: boolean) => void,
		mutation: {
			mutate: (v: boolean, opts: { onError: () => void }) => void;
		},
	) => {
		setLocal(next);
		mutation.mutate(next, { onError: () => setLocal(previous) });
	};

	return (
		<Card className="p-6">
			<div className="space-y-4">
				<div className="flex items-center gap-1.5">
					<Label className="font-semibold text-base">
						Test-case generation
					</Label>
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								type="button"
								className="rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
								aria-label="How test-case generation works"
							>
								<InfoIcon className="size-3.5" />
							</button>
						</TooltipTrigger>
						<TooltipContent className="max-w-xs">
							<p className="font-medium">
								When Fabric drafts test cases:
							</p>
							<ul className="mt-1 space-y-1">
								<li>
									<span className="font-medium">
										Generate manual test cases
									</span>{" "}
									— drafts cases from a feature's acceptance
									criteria. Off stops all drafting for this
									project.
								</li>
								<li>
									<span className="font-medium">
										Apply TDD approach
									</span>{" "}
									— drafts and reviews cases before
									implementation instead of after.
								</li>
							</ul>
						</TooltipContent>
					</Tooltip>
					{/* The QA configuration block below this one is a draft
					    form with its own Save. Saying which model applies is
					    the difference between "I toggled it" and "I toggled it
					    and it took effect". */}
					<span className="text-muted-foreground text-xs">
						Saved as you change them
					</span>
				</div>

				<div className="max-w-xl space-y-4">
					<div className="flex items-start justify-between gap-4">
						<div className="space-y-1">
							<Label htmlFor="qa-generate-manual">
								Generate manual test cases
							</Label>
							<p
								id="qa-generate-manual-desc"
								className="text-muted-foreground text-xs"
							>
								Draft manual test cases from a feature's
								acceptance criteria. Turn this off to stop
								test-case drafting for the whole project — no
								credits are spent while it is off.
							</p>
						</div>
						<Switch
							id="qa-generate-manual"
							checked={generateManual}
							onCheckedChange={(next) =>
								handle(
									next,
									generateManual,
									setGenerateManual,
									generateManualMutation,
								)
							}
							disabled={
								!canEdit || generateManualMutation.isPending
							}
							aria-label="Generate manual test cases"
							aria-describedby="qa-generate-manual-desc"
						/>
					</div>

					<div className="flex items-start justify-between gap-4">
						<div className="space-y-1">
							<Label htmlFor="qa-apply-tdd">
								Apply TDD approach
							</Label>
							<p
								id="qa-apply-tdd-desc"
								className="text-muted-foreground text-xs"
							>
								Draft test cases from the acceptance criteria
								before implementation and review the
								requirements against them. When off, cases are
								drafted after the feature is reviewed.
							</p>
						</div>
						<Switch
							id="qa-apply-tdd"
							checked={applyTdd}
							onCheckedChange={(next) =>
								handle(
									next,
									applyTdd,
									setApplyTdd,
									applyTddMutation,
								)
							}
							disabled={
								!canEdit ||
								!generateManual ||
								applyTddMutation.isPending
							}
							aria-label="Apply TDD approach"
							aria-describedby={
								generateManual
									? "qa-apply-tdd-desc"
									: "qa-apply-tdd-desc qa-tdd-off-note"
							}
						/>
					</div>

					<div className="flex items-start justify-between gap-4">
						<div className="space-y-1">
							<Label htmlFor="qa-auto-create-bugs">
								Open bugs for failing tests
							</Label>
							<p
								id="qa-auto-create-bugs-desc"
								className="text-muted-foreground text-xs"
							>
								When a connected CI pipeline reports a linked
								test case as failing, automatically open a bug
								for it. One bug per case — it won't be reopened
								while a bug is already open. Off by default.
							</p>
						</div>
						<Switch
							id="qa-auto-create-bugs"
							checked={autoCreateBugs}
							onCheckedChange={(next) =>
								handle(
									next,
									autoCreateBugs,
									setAutoCreateBugs,
									autoCreateBugsMutation,
								)
							}
							disabled={
								!canEdit || autoCreateBugsMutation.isPending
							}
							aria-label="Open bugs for failing tests"
							aria-describedby="qa-auto-create-bugs-desc"
						/>
					</div>

					{!generateManual && (
						<p
							id="qa-tdd-off-note"
							className="text-muted-foreground text-xs"
						>
							Test-case generation is off, so the TDD ordering has
							no effect until you turn generation on.
						</p>
					)}
					{!canEdit && (
						<p className="text-muted-foreground text-xs">
							Only project admins can change these settings.
						</p>
					)}
				</div>
			</div>
		</Card>
	);
}
