"use client";

import { aiFillableParameters } from "@repo/database/prisma/queries/lib/report-parameter-ai-defaults";
import {
	initialParameterValues,
	missingRequiredParameters,
	offerParameterValues,
	parameterValuesToSave,
	reportParameterFields,
} from "@saas/reports/lib/report-parameter-values";
import type { ReportPromptDefaults } from "@saas/reports/lib/report-template-defaults";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Loader2Icon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { SmartParameterInput } from "./SmartParameterInput";

export type ReportParameterState = {
	/** Required parameters still empty, by key. */
	missing: string[];
	/** The required parameters as the readiness checks read them. */
	requiredParams: Array<{
		key: string;
		value: string;
		hasDefault: boolean;
	}>;
	/** What `reports.instances.create` saves as the report's own values. */
	toSave: Record<string, string>;
};

/**
 * The settings of a report being created. They arrive filled: the template's
 * values, what the project answers, the organization's and the project's
 * defaults, then AI's suggestions from the project's name and description for
 * whatever is still empty. A field the person has typed in is left alone, every
 * value stays editable, and a failed suggestion leaves the field empty.
 *
 * Rendered only with the report suite on. The state lives here and is reported
 * up, because its queries do not exist for a page without the suite.
 */
export function ReportParameterFields({
	templateId,
	parameters,
	projectId,
	organizationId,
	onChange,
	onContextDefaults,
	onPromptDefaults,
}: {
	templateId: string;
	parameters: unknown;
	projectId: string;
	organizationId: string | null;
	onChange: (state: ReportParameterState) => void;
	onContextDefaults: (context: Record<string, string>) => void;
	onPromptDefaults: (prompts: ReportPromptDefaults | null) => void;
}) {
	const fields = useMemo(
		() => reportParameterFields(parameters),
		[parameters],
	);
	const [values, setValues] = useState(() =>
		initialParameterValues(parameters, null),
	);
	const typedRef = useRef(new Set<string>());
	const [suggested, setSuggested] = useState<Record<string, string>>({});

	const { data: projectData } = useQuery(
		orpc.reports.project.queryOptions({
			input: { id: projectId, organizationId },
		}),
	);
	const projectName = projectData?.project?.name;
	useEffect(() => {
		setValues((current) =>
			offerParameterValues(
				current,
				initialParameterValues(parameters, projectName),
				typedRef.current,
			),
		);
	}, [parameters, projectName]);

	// Kept for the session: reopening the template asks AI nothing new.
	const defaults = useQuery({
		...orpc.reports.templates.parameterDefaults.queryOptions({
			input: { templateId, projectId, organizationId },
		}),
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
	});
	const arrived = defaults.data;
	useEffect(() => {
		if (!arrived) {
			return;
		}
		setSuggested(arrived.suggested);
		setValues((current) =>
			offerParameterValues(
				offerParameterValues(current, arrived.values, typedRef.current),
				arrived.suggested,
				typedRef.current,
			),
		);
		onContextDefaults(arrived.context);
		onPromptDefaults(arrived.prompts);
	}, [arrived, onContextDefaults, onPromptDefaults]);

	useEffect(() => {
		onChange({
			missing: missingRequiredParameters(fields, values),
			requiredParams: fields
				.filter((field) => field.required)
				.map((field) => ({
					key: field.key,
					value: values[field.key] ?? "",
					hasDefault: field.hasDefault,
				})),
			toSave: parameterValuesToSave(values, typedRef.current, suggested),
		});
	}, [fields, values, suggested, onChange]);

	if (fields.length === 0) {
		return null;
	}
	const suggesting =
		defaults.isFetching &&
		aiFillableParameters(parameters, values).length > 0;
	const suggestedCount = Object.keys(suggested).length;
	const suggestionOutcome = defaults.isError
		? "Could not suggest values; fill these in."
		: suggestedCount > 0
			? `Filled ${suggestedCount} ${suggestedCount === 1 ? "value" : "values"}; check them.`
			: null;

	return (
		<div className="space-y-4">
			<div>
				<h3 className="font-medium">Parameters</h3>
				<p className="text-sm text-muted-foreground">
					Filled in from the project where Fabric can. Change anything
					here, now or on the report page later.
				</p>
			</div>
			<p
				aria-live="polite"
				className="flex min-h-4 items-center gap-2 text-xs text-muted-foreground"
			>
				{suggesting ? (
					<>
						<Loader2Icon
							aria-hidden="true"
							className="h-3 w-3 motion-safe:animate-spin"
						/>
						Suggesting values from the project...
					</>
				) : (
					suggestionOutcome
				)}
			</p>
			<div className="space-y-4">
				{fields.map((field) => (
					<SmartParameterInput
						key={field.key}
						name={field.key}
						schema={field.schema}
						value={values[field.key] ?? ""}
						isRequired={field.required}
						enhanced
						onChange={(value) => {
							typedRef.current.add(field.key);
							setValues((current) => ({
								...current,
								[field.key]: value,
							}));
						}}
					/>
				))}
			</div>
		</div>
	);
}
