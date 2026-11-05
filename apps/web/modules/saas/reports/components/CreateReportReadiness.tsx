"use client";

import type { InstanceDataSourceSetup } from "@saas/reports/hooks/use-instance-data-source-setup";
import {
	computeReportReadiness,
	type ReportReadiness,
} from "@saas/reports/lib/report-readiness";
import {
	isRequiredDataSource,
	reportDataSourceLabel,
} from "@saas/reports/lib/report-template-definition";
import type { DataSourceDefinition } from "@saas/shared/components/DataSourceDefinitionBuilder";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { cn } from "@ui/lib";
import {
	AlertCircleIcon,
	CheckCircle2Icon,
	CircleDashedIcon,
	Loader2Icon,
	RotateCcwIcon,
	XCircleIcon,
} from "lucide-react";
import { useEffect, useMemo } from "react";

const STATUS_ICON = {
	ok: { Icon: CheckCircle2Icon, className: "text-success" },
	warn: { Icon: AlertCircleIcon, className: "text-highlight" },
	fail: { Icon: XCircleIcon, className: "text-destructive" },
};

/** For a failed test that came back without a message of its own. */
function connectionOutcomeSentence(
	outcome:
		| "connected"
		| "auth_failed"
		| "unreachable"
		| "zero_tools"
		| "no_read_only_tools"
		| "error",
): string {
	switch (outcome) {
		case "connected":
			return "Connected.";
		case "auth_failed":
			return "Its sign-in has expired or was refused. Reconnect it.";
		case "unreachable":
			return "It could not be reached. Try again in a moment.";
		case "zero_tools":
			return "It offers no tools.";
		case "no_read_only_tools":
			return "It offers no read-only tools for a report to use.";
		case "error":
			return "The test failed.";
		default: {
			const unhandled: never = outcome;
			throw new Error(`Unhandled connection outcome: ${unhandled}`);
		}
	}
}

/**
 * Whether the report could run, before it exists: the report page's readiness
 * checks, fed by a live test of the connections the person has chosen. The test
 * connects and lists tools only, so it costs no credits. A required connection
 * that fails is reported up: Generate would be refused for it.
 */
export function CreateReportReadiness({
	templateId,
	dataSources,
	setup,
	requiredParams,
	outputFormat,
	onConnectionFailure,
}: {
	templateId: string;
	dataSources: DataSourceDefinition[];
	setup: Pick<
		InstanceDataSourceSetup,
		"bindings" | "organizationId" | "contextFields" | "contextValues"
	>;
	requiredParams: Array<{ key: string; value: string; hasDefault: boolean }>;
	outputFormat: string;
	onConnectionFailure: (reason: string | null) => void;
}) {
	const { bindings, organizationId } = setup;
	const sources = dataSources.filter((ds) => ds.type !== "fabric");
	const configIds = [
		...new Set(
			sources
				.filter(isRequiredDataSource)
				.flatMap((ds) => bindings[ds.id]?.mcpConfigId ?? []),
		),
	];
	const probe = useQuery({
		...orpc.reports.instances.probeConnections.queryOptions({
			input: { templateId, organizationId, configIds },
		}),
		enabled: configIds.length > 0,
		retry: false,
		staleTime: 30_000,
		refetchOnWindowFocus: false,
	});
	// The answer of a request for other connections never counts here, nor the
	// last answer once a new test has failed.
	const diagnostics =
		configIds.length === 0
			? []
			: probe.isError
				? undefined
				: probe.data?.diagnostics;

	const readiness: ReportReadiness = computeReportReadiness({
		templateNeedsDataSource: sources.length > 0,
		requiredDataSources: sources.map((ds) => ({
			key: ds.id,
			name: reportDataSourceLabel(ds),
			required: isRequiredDataSource(ds),
		})),
		bindings: Object.fromEntries(
			sources.map((ds) => [ds.id, { id: bindings[ds.id]?.mcpConfigId }]),
		),
		diagnostics,
		requiredParams,
		requiredContextFields: setup.contextFields
			.filter((field) => field.required)
			.map((field) => ({
				key: field.key,
				label: field.label,
				value: setup.contextValues[field.key],
			})),
		skillsCount: 0,
		outputFormat,
		dataSourceLabel: "",
	});

	const failures = useMemo(
		() =>
			(diagnostics ?? []).filter(
				(diagnostic) => diagnostic.outcome !== "connected",
			),
		[diagnostics],
	);
	const failureReason =
		failures.length > 0
			? `${failures.map((failure) => failure.serverName).join(", ")} did not pass the connection test.`
			: null;
	useEffect(() => {
		onConnectionFailure(failureReason);
	}, [failureReason, onConnectionFailure]);

	const checks = readiness.checks.filter(
		(check) => check.key === "connection" || check.key === "params",
	);
	// "Connected" here only means chosen: it is not a pass until a test says so.
	const connectionUnproven =
		readiness.connection === "connected" &&
		(probe.isFetching || !readiness.connectionTested);
	const untestedNote =
		configIds.length === 0
			? "No connection is chosen, so there is nothing to test."
			: probe.isError
				? "The connections could not be tested. Generate tests them again before it starts."
				: "The connections have not been tested yet.";
	const testOutcome = probe.isFetching
		? "Testing connections."
		: probe.isError
			? "The connections could not be tested."
			: (failureReason ??
				(readiness.connection === "connected" &&
				readiness.connectionTested
					? "The connections passed the test."
					: ""));

	return (
		<section
			aria-label="Readiness"
			className="space-y-2 rounded-lg border bg-muted/40 p-4"
		>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h3 className="font-medium">Readiness</h3>
				{configIds.length > 0 && (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="h-7 text-xs aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
						aria-disabled={probe.isFetching || undefined}
						onClick={() => {
							if (!probe.isFetching) {
								void probe.refetch();
							}
						}}
					>
						<RotateCcwIcon
							aria-hidden="true"
							className="mr-1 h-3 w-3"
						/>
						Test again
					</Button>
				)}
			</div>
			<p role="status" className="sr-only">
				{testOutcome}
			</p>
			<ul className="space-y-1">
				{checks.map((check) => {
					if (check.key === "connection" && connectionUnproven) {
						return (
							<li
								key={check.key}
								className="flex items-start gap-2 text-sm"
							>
								{probe.isFetching ? (
									<Loader2Icon
										aria-hidden="true"
										className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground motion-safe:animate-spin"
									/>
								) : (
									<CircleDashedIcon
										aria-hidden="true"
										className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
									/>
								)}
								<span>
									{probe.isFetching
										? "Testing"
										: "Not tested"}
									<span className="block text-xs text-muted-foreground">
										{probe.isFetching
											? "Checking that Fabric can reach the connections you chose."
											: untestedNote}
									</span>
								</span>
							</li>
						);
					}
					const { Icon, className } = STATUS_ICON[check.status];
					return (
						<li
							key={check.key}
							className="flex items-start gap-2 text-sm"
						>
							<Icon
								aria-hidden="true"
								className={cn(
									"mt-0.5 h-4 w-4 shrink-0",
									className,
								)}
							/>
							<span>
								{check.label}
								<span className="block text-xs text-muted-foreground">
									{check.note}
								</span>
							</span>
						</li>
					);
				})}
			</ul>
			{failures.length > 0 && (
				<ul role="alert" className="space-y-1">
					{failures.map((failure) => (
						<li
							key={failure.configId}
							className="break-words text-xs text-destructive [overflow-wrap:anywhere]"
						>
							{failure.serverName}:{" "}
							{failure.errorMessage ||
								connectionOutcomeSentence(failure.outcome)}
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
