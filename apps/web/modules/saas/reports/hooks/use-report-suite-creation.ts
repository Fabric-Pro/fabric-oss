"use client";

import type { ReportParameterState } from "@saas/reports/components/ReportParameterFields";
import type { ReportConnectionsState } from "@saas/reports/hooks/use-instance-data-source-setup";
import {
	type ReportGenerateOutcome,
	routeGenerateOutcome,
} from "@saas/reports/lib/report-generate-outcome";
import { unboundRequiredSources } from "@saas/reports/lib/report-template-definition";
import type { DataSourceDefinition } from "@saas/shared/components/DataSourceDefinitionBuilder";
import { orpcClient } from "@shared/lib/orpc-client";
import { useRouter } from "next/navigation";
import { useState } from "react";

const NO_PARAMETERS: ReportParameterState = {
	missing: [],
	requiredParams: [],
	toSave: {},
};

/**
 * What the report suite's dialog and form add to creating a report: the state of
 * its settings and readiness checks, what still stops it from generating, and
 * starting the run once the report exists. With the suite off none of it applies
 * and creating a report stays as it was.
 */
export function useReportSuiteCreation({
	suite,
	dataSources,
	bindings,
	organizationId,
	basePath,
	onLeave,
}: {
	suite: boolean;
	dataSources: DataSourceDefinition[];
	bindings: Record<string, { mcpConfigId: string } | undefined>;
	organizationId: string | null;
	basePath: string;
	/** Runs before the page moves to the new report. */
	onLeave?: () => void;
}) {
	const router = useRouter();
	const [parameters, setParameters] =
		useState<ReportParameterState>(NO_PARAMETERS);
	const [connectionFailure, setConnectionFailure] = useState<string | null>(
		null,
	);
	const [isStarting, setIsStarting] = useState(false);

	const startGeneration = async (instanceId: string) => {
		setIsStarting(true);
		// Both outcomes leave for the report's page, so this stays pending until
		// the route changes and a click meanwhile cannot start a second run.
		const leaveWith = (outcome: ReportGenerateOutcome) => {
			onLeave?.();
			routeGenerateOutcome(outcome, basePath, router.push);
		};
		try {
			const { startConfirmed } =
				await orpcClient.reports.instances.execute({
					instanceId,
					organizationId,
				});
			leaveWith({ outcome: "started", instanceId, startConfirmed });
		} catch (error) {
			leaveWith({
				outcome: "refused",
				instanceId,
				reason:
					error instanceof Error
						? error.message
						: "The report could not start.",
			});
		}
	};

	return {
		parameters,
		setParameters,
		connectionFailure,
		setConnectionFailure,
		isStarting,
		startGeneration,
		/** Required sources with no connection, by the name to connect them under. */
		missingSources: suite
			? unboundRequiredSources(dataSources, bindings)
			: [],
		/** Set when something other than a connection or the name stops the run. */
		blocked: parameters.missing.length > 0 || connectionFailure !== null,
	};
}

/** The footer's sentence for the required sources still unconnected. */
function connectToGenerateMessage(missingSources: string[]): string {
	return `Connect ${missingSources.join(", ")} to generate this report.`;
}

/**
 * Why Generate is off, for the sentence beside it and the button's description.
 * Until the connections have answered, nothing is said to be missing: `urgent` is
 * false and the message only says what is happening.
 */
export function generateProblem({
	connections,
	missingSources,
	connectionFailure,
	missingParameters,
	setupIncomplete,
	nameMissing,
}: {
	connections: ReportConnectionsState;
	missingSources: string[];
	connectionFailure: string | null;
	missingParameters: boolean;
	setupIncomplete: boolean;
	nameMissing: boolean;
}): { message: string; urgent: boolean } | null {
	if (missingSources.length > 0) {
		switch (connections) {
			case "loading":
				return {
					message: "Checking your connected tools...",
					urgent: false,
				};
			case "failed":
				return {
					message: "Your connected tools could not be loaded.",
					urgent: false,
				};
			case "answered":
				return {
					message: connectToGenerateMessage(missingSources),
					urgent: true,
				};
			default: {
				const unhandled: never = connections;
				throw new Error(`Unhandled connections state: ${unhandled}`);
			}
		}
	}
	if (connectionFailure) {
		return { message: connectionFailure, urgent: true };
	}
	if (missingParameters) {
		return {
			message: "Fill in the required parameters to generate this report.",
			urgent: true,
		};
	}
	if (setupIncomplete) {
		return {
			message: "Fill in the report context to generate this report.",
			urgent: true,
		};
	}
	if (nameMissing) {
		return {
			message: "Enter a name to generate this report.",
			urgent: true,
		};
	}
	return null;
}
