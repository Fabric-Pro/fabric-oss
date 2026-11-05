"use client";

import {
	organizationConfigurationChanges,
	projectConfigurationChanges,
	type ReportConfigurationChanges,
	storedDefaultsForTemplate,
	templateConfigurationChanges,
} from "@saas/reports/lib/report-configuration-save";
import { defaultsWithReportValues } from "@saas/reports/lib/report-template-defaults";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ui/components/alert-dialog";
import { Button } from "@ui/components/button";
import {
	BookmarkPlusIcon,
	Building2Icon,
	FolderIcon,
	Loader2Icon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

type Destination = "template" | "organization" | "project";

type Props = {
	report: {
		organizationId: string | null;
		templateId: string;
		projectId: string | null;
		canSaveToTemplate: boolean;
		canSetOrganizationDefault: boolean;
		canSetOrganizationPrompts: boolean;
		canSetProjectDefault: boolean;
		connections: unknown;
		fabricConfig: unknown;
		parameterDefaults: unknown;
		template: {
			name: string;
			scope: string;
			isPublic: boolean;
			definition: unknown;
			parameters: unknown;
			fabricConfig?: unknown;
		};
	};
	/** Reads the report again, so the template's new values show. */
	onSaved: () => void;
};

/** "prompts", "parameter values" or both, for the confirmation's sentence. */
function changesLabel(changes: ReportConfigurationChanges): string {
	if (changes.prompts && changes.parameterDefaults) {
		return "prompts and parameter values";
	}
	return changes.prompts ? "prompts" : "parameter values";
}

function confirmationTitle(destination: Destination, name: string): string {
	switch (destination) {
		case "template":
			return `Update “${name}”?`;
		case "organization":
			return "Set as the organization's default?";
		case "project":
			return "Set as this project's default?";
		default: {
			const unhandled: never = destination;
			throw new Error(`Unhandled destination: ${unhandled}`);
		}
	}
}

function confirmationAction(destination: Destination): string {
	switch (destination) {
		case "template":
			return "Update template";
		case "organization":
		case "project":
			return "Set as default";
		default: {
			const unhandled: never = destination;
			throw new Error(`Unhandled destination: ${unhandled}`);
		}
	}
}

function confirmationDescription(
	destination: Destination,
	name: string,
	label: string,
	sharedTemplate: boolean,
): string {
	switch (destination) {
		case "template":
			return sharedTemplate
				? `The template takes this report's ${label}. New reports from it in every organization use them, so check that nothing here belongs to one organization.`
				: `The template takes this report's ${label}. New reports from it use them.`;
		case "organization":
			return `New reports from “${name}” in this organization start with this report's ${label}. Defaults this report does not change keep their current values, and the template itself does not change.`;
		case "project":
			return `New reports from “${name}” in this project start with this report's ${label}. Defaults this report does not change keep their current values, and the template itself does not change.`;
		default: {
			const unhandled: never = destination;
			throw new Error(`Unhandled destination: ${unhandled}`);
		}
	}
}

/**
 * Hands a saved report's edited prompts and parameter values on, for whoever
 * may: "Update template" writes them into the template, "Set as organization
 * default" and "Set as project default" make them the starting values for new
 * reports from it there. Each offer goes away once its values are saved.
 * Reports already made keep their own values.
 */
export function SaveReportConfigurationMenu({ report, onSaved }: Props) {
	const [confirming, setConfirming] = useState<Destination | null>(null);
	// Every read and write names the report's organization: the session can
	// have moved to another one since this page opened.
	const organizationId = report.organizationId ?? undefined;

	// What each default already holds decides what is left to offer, and is
	// sent back unchanged with the report's values.
	const overrides = useQuery({
		...orpc.reports.templates.overrides.get.queryOptions({
			input: {
				organizationId,
				templateId: report.templateId,
				projectId: report.projectId ?? undefined,
			},
		}),
		enabled:
			report.canSetOrganizationDefault || report.canSetProjectDefault,
	});
	const stored = overrides.data;

	const offers: Record<Destination, ReportConfigurationChanges | null> = {
		template: report.canSaveToTemplate
			? templateConfigurationChanges(report)
			: null,
		organization:
			report.canSetOrganizationDefault && stored
				? organizationConfigurationChanges(
						report,
						stored.organization,
						{ includePrompts: report.canSetOrganizationPrompts },
					)
				: null,
		project:
			report.canSetProjectDefault && stored
				? projectConfigurationChanges(report, stored)
				: null,
	};

	const close = () => setConfirming(null);
	const saveToTemplate = useMutation(
		orpc.reports.templates.savePrompt.mutationOptions({
			onSuccess: () => {
				toast.success(
					"Template updated. New reports use these values.",
				);
				close();
				onSaved();
			},
			onError: (error) => {
				toast.error(error.message || "Failed to update the template");
			},
		}),
	);
	const setDefault = useMutation(
		orpc.reports.templates.overrides.set.mutationOptions({
			onSuccess: (_result, variables) => {
				toast.success(
					variables.scope === "PROJECT"
						? "Project default saved. New reports in this project start with these values."
						: "Organization default saved. New reports start with these values.",
				);
				close();
				void overrides.refetch();
			},
			onError: (error) => {
				toast.error(error.message || "Failed to save the default");
			},
		}),
	);

	if (!offers.template && !offers.organization && !offers.project) {
		return null;
	}

	const isSaving = saveToTemplate.isPending || setDefault.isPending;
	const confirmingChanges = confirming ? offers[confirming] : null;
	const confirm = () => {
		if (confirming === "template" && offers.template) {
			saveToTemplate.mutate({
				organizationId,
				templateId: report.templateId,
				...offers.template.prompts,
				...(offers.template.parameterDefaults
					? { parameterDefaults: offers.template.parameterDefaults }
					: {}),
			});
		} else if (
			confirming === "organization" &&
			offers.organization &&
			stored
		) {
			setDefault.mutate({
				organizationId,
				templateId: report.templateId,
				projectId: report.projectId ?? undefined,
				scope: "ORGANIZATION",
				defaults: defaultsWithReportValues(
					storedDefaultsForTemplate(
						stored.organization,
						report.template.definition,
					),
					offers.organization,
				),
			});
		} else if (
			confirming === "project" &&
			offers.project &&
			stored &&
			report.projectId
		) {
			setDefault.mutate({
				organizationId,
				templateId: report.templateId,
				projectId: report.projectId,
				scope: "PROJECT",
				defaults: defaultsWithReportValues(
					storedDefaultsForTemplate(
						stored.project,
						report.template.definition,
					),
					offers.project,
				),
			});
		}
	};

	return (
		<div className="flex flex-wrap items-center gap-2 border-t pt-4">
			<p className="mr-auto text-xs text-muted-foreground">
				New reports do not start with this report's configuration.
			</p>
			{offers.template && (
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => setConfirming("template")}
				>
					<BookmarkPlusIcon className="mr-2 h-4 w-4" />
					Update template
				</Button>
			)}
			{offers.organization && (
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => setConfirming("organization")}
				>
					<Building2Icon className="mr-2 h-4 w-4" />
					Set as organization default
				</Button>
			)}
			{offers.project && (
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => setConfirming("project")}
				>
					<FolderIcon className="mr-2 h-4 w-4" />
					Set as project default
				</Button>
			)}

			<AlertDialog
				open={confirming !== null}
				onOpenChange={(open) => {
					if (!open && !isSaving) {
						close();
					}
				}}
			>
				<AlertDialogContent>
					{confirming && (
						<AlertDialogHeader>
							<AlertDialogTitle>
								{confirmationTitle(
									confirming,
									report.template.name,
								)}
							</AlertDialogTitle>
							<AlertDialogDescription>
								{confirmationDescription(
									confirming,
									report.template.name,
									confirmingChanges
										? changesLabel(confirmingChanges)
										: "values",
									report.template.scope === "SYSTEM" ||
										report.template.isPublic,
								)}{" "}
								Reports already made keep their own values.
							</AlertDialogDescription>
						</AlertDialogHeader>
					)}
					<AlertDialogFooter>
						<AlertDialogCancel disabled={isSaving}>
							Cancel
						</AlertDialogCancel>
						{confirming && (
							<Button
								type="button"
								disabled={isSaving || !confirmingChanges}
								onClick={confirm}
							>
								{isSaving && (
									<Loader2Icon
										aria-hidden="true"
										className="mr-2 h-4 w-4 motion-safe:animate-spin"
									/>
								)}
								{confirmationAction(confirming)}
							</Button>
						)}
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
