"use client";

import { Button } from "@ui/components/button";
import { cn } from "@ui/lib";
import { useTranslations } from "next-intl";
import { PipelineProviderIcon } from "./PipelineProviderIcon";

/**
 * Source and outcome filters for the run history.
 *
 * The history had none, which stopped being tolerable once Fabric's own agentic
 * runs started landing in the same list as CI-reported ones: a project that runs
 * its cases through Fabric buries its nightly GitHub Actions run under dozens of
 * one-case agentic runs, and "show me what CI said" had no answer.
 *
 * Multi-select rather than a single choice, because "GitHub or GitLab" is a real
 * question on a multi-repo project. Nothing selected means unfiltered — the
 * honest reading of an empty filter, and it keeps the control from ever
 * producing a blank list the reader cannot explain.
 *
 * Only the sources this project HAS are offered. Listing every provider Fabric
 * can ingest would present four filters that return nothing on a project with
 * one repo.
 */

/** Provider-independent outcomes understood by the run-history API. */
const RUN_STATUS_FILTERS = ["passed", "failed", "cancelled"] as const;
export type RunStatusFilter = (typeof RUN_STATUS_FILTERS)[number];

export function RunFilters({
	availableProviders,
	providers,
	statuses,
	onProvidersChange,
	onStatusesChange,
	className,
}: {
	/** Provider tags actually present in this project's history. */
	availableProviders: string[];
	providers: string[];
	statuses: RunStatusFilter[];
	onProvidersChange: (next: string[]) => void;
	onStatusesChange: (next: RunStatusFilter[]) => void;
	className?: string;
}) {
	const t = useTranslations(
		"projects.stories.maturation.qa.pipelineRuns.filters",
	);

	function toggle<T extends string>(list: T[], value: T): T[] {
		return list.includes(value)
			? list.filter((item) => item !== value)
			: [...list, value];
	}

	const hasAny = providers.length > 0 || statuses.length > 0;

	// A project with one source has nothing to choose between; the outcome
	// filters still earn their place.
	const showProviders = availableProviders.length > 1;

	return (
		<div className={cn("flex flex-wrap items-center gap-1.5", className)}>
			{showProviders &&
				availableProviders.map((provider) => {
					const active = providers.includes(provider);
					return (
						<Button
							key={provider}
							type="button"
							size="sm"
							variant={active ? "secondary" : "outline"}
							aria-pressed={active}
							className="h-7 gap-1.5 px-2 text-xs"
							onClick={() =>
								onProvidersChange(toggle(providers, provider))
							}
						>
							<PipelineProviderIcon
								provider={provider}
								className="size-3.5"
							/>
							{t(`provider.${provider}`)}
						</Button>
					);
				})}

			{RUN_STATUS_FILTERS.map((status) => {
				const active = statuses.includes(status);
				return (
					<Button
						key={status}
						type="button"
						size="sm"
						variant={active ? "secondary" : "outline"}
						aria-pressed={active}
						className="h-7 px-2 text-xs"
						onClick={() =>
							onStatusesChange(toggle(statuses, status))
						}
					>
						{t(`status.${status}`)}
					</Button>
				);
			})}

			{hasAny && (
				<Button
					type="button"
					size="sm"
					variant="ghost"
					className="h-7 px-2 text-muted-foreground text-xs"
					onClick={() => {
						onProvidersChange([]);
						onStatusesChange([]);
					}}
				>
					{t("clear")}
				</Button>
			)}
		</div>
	);
}
