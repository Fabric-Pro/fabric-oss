"use client";

import { useDialogFocusReturn } from "@saas/reports/hooks/use-dialog-focus-return";
import {
	DEFAULT_SCHEDULE_FREQUENCIES,
	type DefaultScheduleFrequency,
	defaultsFromDraft,
	defaultsWithoutPrompts,
	draftFromDefaults,
	FREQUENCY_LABEL,
	type ReportDefaultsDraft,
	type ReportDefaultsScope,
	type ReportPromptDefaults,
	templateParameterFields,
} from "@saas/reports/lib/report-template-defaults";
import { Spinner } from "@shared/components/Spinner";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import { RotateCcwIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

const NO_SCHEDULE = "none";

const SCOPE_LABEL: Record<ReportDefaultsScope, string> = {
	PROJECT: "This project",
	ORGANIZATION: "Organization",
};

const SAVE_LABEL: Record<ReportDefaultsScope, string> = {
	PROJECT: "Save project defaults",
	ORGANIZATION: "Save organization defaults",
};

const PROMPTS_HEADING: Record<ReportDefaultsScope, string> = {
	PROJECT: "Project default prompts",
	ORGANIZATION: "Organization default prompts",
};

const PROMPTS_NOTE: Record<ReportDefaultsScope, string> = {
	PROJECT:
		"New reports from this template in this project start with these prompts, ahead of the organization's.",
	ORGANIZATION:
		"New reports from this template in the organization start with these prompts.",
};

type Props = {
	template: { id: string; name: string };
	projectId: string;
	onClose: () => void;
};

function isFrequency(value: string): value is DefaultScheduleFrequency {
	return DEFAULT_SCHEDULE_FREQUENCIES.some(
		(frequency) => frequency === value,
	);
}

/** One scope's form: the template's parameters and the schedule. */
function DefaultsForm({
	scope,
	fields,
	draft,
	scheduleLocked,
	onChange,
}: {
	scope: ReportDefaultsScope;
	fields: ReturnType<typeof templateParameterFields>;
	draft: ReportDefaultsDraft;
	scheduleLocked: boolean;
	onChange: (
		update: (draft: ReportDefaultsDraft) => ReportDefaultsDraft,
	) => void;
}) {
	const idPrefix = `report-default-${scope.toLowerCase()}`;
	const scheduleNoteId = `${idPrefix}-schedule-note`;
	return (
		<div className="space-y-5">
			{fields.length > 0 && (
				<section className="space-y-3">
					<h3 className="text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
						Parameters
					</h3>
					{fields.map((field) => {
						const inputId = `${idPrefix}-${field.key}`;
						const descriptionId = field.description
							? `${inputId}-description`
							: undefined;
						return (
							<div key={field.key} className="space-y-1">
								<div className="flex items-center gap-2">
									<Label htmlFor={inputId}>
										{field.title}
									</Label>
									{field.required && (
										<span className="text-xs text-muted-foreground">
											Required in reports
										</span>
									)}
								</div>
								{field.description && (
									<p
										id={descriptionId}
										className="text-xs text-muted-foreground"
									>
										{field.description}
									</p>
								)}
								<Input
									id={inputId}
									aria-describedby={descriptionId}
									value={draft.parameters[field.key] ?? ""}
									onChange={(event) => {
										const value = event.target.value;
										onChange((current) => ({
											...current,
											parameters: {
												...current.parameters,
												[field.key]: value,
											},
										}));
									}}
								/>
							</div>
						);
					})}
				</section>
			)}

			<section className="space-y-1">
				<Label htmlFor={`${idPrefix}-schedule`}>Schedule</Label>
				{scheduleLocked && (
					<p
						id={scheduleNoteId}
						className="text-xs text-muted-foreground"
					>
						You can’t change this, because scheduled runs spend the
						owner’s connections and credits.
					</p>
				)}
				<Select
					disabled={scheduleLocked}
					value={draft.frequency ?? NO_SCHEDULE}
					onValueChange={(value) =>
						onChange((current) => ({
							...current,
							frequency: isFrequency(value) ? value : null,
						}))
					}
				>
					<SelectTrigger
						id={`${idPrefix}-schedule`}
						aria-describedby={
							scheduleLocked ? scheduleNoteId : undefined
						}
						className="max-w-xs"
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={NO_SCHEDULE}>
							The template's schedule
						</SelectItem>
						{DEFAULT_SCHEDULE_FREQUENCIES.map((frequency) => (
							<SelectItem key={frequency} value={frequency}>
								{FREQUENCY_LABEL[frequency]}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</section>
		</div>
	);
}

/**
 * A scope's default prompts, saved from a report page with "Set as organization
 * default" or "Set as project default": read here, and cleared by whoever may
 * set them.
 */
function PromptDefaults({
	scope,
	prompts,
	showPrompts,
	clearing,
	onClear,
}: {
	scope: ReportDefaultsScope;
	prompts: ReportPromptDefaults;
	/**
	 * False for prompts left from before the organization owned the template:
	 * its own templates' prompts are edited on the template, so these can
	 * only be cleared.
	 */
	showPrompts: boolean;
	clearing: boolean;
	onClear: () => void;
}) {
	const aiTasks = showPrompts ? Object.entries(prompts.aiTasks ?? {}) : [];
	const headingId = `report-default-prompts-${scope.toLowerCase()}`;
	return (
		<section
			aria-labelledby={headingId}
			className="space-y-3 rounded-md border bg-muted/40 p-3"
		>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h3
					id={headingId}
					className="text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground"
				>
					{PROMPTS_HEADING[scope]}
				</h3>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					disabled={clearing}
					onClick={onClear}
					aria-label={`Clear default prompts: ${SCOPE_LABEL[scope]}`}
				>
					<Trash2Icon className="mr-2 h-4 w-4" />
					Clear default prompts
				</Button>
			</div>
			<p className="text-xs text-muted-foreground">
				{showPrompts
					? PROMPTS_NOTE[scope]
					: "Default prompts are still stored for this template, which the organization now owns. Change its prompts on the template, and clear these."}
			</p>
			{showPrompts && prompts.systemPrompt && (
				<div className="space-y-1">
					<p className="text-xs font-medium">System prompt</p>
					<p className="whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">
						{prompts.systemPrompt}
					</p>
				</div>
			)}
			{showPrompts && prompts.userPrompt && (
				<div className="space-y-1">
					<p className="text-xs font-medium">Report instructions</p>
					<p className="whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">
						{prompts.userPrompt}
					</p>
				</div>
			)}
			{aiTasks.map(([key, task]) => (
				<div key={key} className="space-y-1">
					<p className="font-mono text-xs font-medium">{key}</p>
					<p className="whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">
						{task}
					</p>
				</div>
			))}
		</section>
	);
}

/**
 * The defaults new reports from a template start with: this project's (for
 * whoever may edit its reports) and the organization's (for its admins and
 * owners). A new report takes the project's values over the organization's
 * over the template's; reports that already exist keep theirs. Each scope
 * keeps its own unsaved edits while the dialog is open.
 */
export function ReportTemplateDefaultsDialog({
	template,
	projectId,
	onClose,
}: Props) {
	const queryClient = useQueryClient();
	const queryOptions = orpc.reports.templates.overrides.get.queryOptions({
		input: { templateId: template.id, projectId },
	});
	const { data, isLoading, isError, isFetching, refetch } =
		useQuery(queryOptions);
	const editableScopes: ReportDefaultsScope[] = [];
	if (data?.canSetProject) {
		editableScopes.push("PROJECT");
	}
	if (data?.canSetOrganization) {
		editableScopes.push("ORGANIZATION");
	}
	const [scope, setScope] = useState<ReportDefaultsScope>("PROJECT");
	const activeScope = editableScopes.includes(scope)
		? scope
		: editableScopes[0];
	const [drafts, setDrafts] = useState<
		Partial<Record<ReportDefaultsScope, ReportDefaultsDraft>>
	>({});
	const savedFor = (option: ReportDefaultsScope) =>
		option === "ORGANIZATION"
			? (data?.organization ?? null)
			: (data?.project ?? null);
	const draftFor = (option: ReportDefaultsScope) =>
		drafts[option] ?? draftFromDefaults(savedFor(option));
	const updateDraft =
		(option: ReportDefaultsScope) =>
		(update: (draft: ReportDefaultsDraft) => ReportDefaultsDraft) =>
			setDrafts((current) => ({
				...current,
				[option]: update(
					current[option] ?? draftFromDefaults(savedFor(option)),
				),
			}));

	const saveMutation = useMutation(
		orpc.reports.templates.overrides.set.mutationOptions({
			onSuccess: (result, variables) => {
				toast.success(
					result.cleared
						? "Defaults cleared"
						: "Defaults saved for new reports",
				);
				// The saved values are read again in place of the edits.
				setDrafts((current) => {
					const next = { ...current };
					delete next[variables.scope];
					return next;
				});
				queryClient.invalidateQueries({
					queryKey: queryOptions.queryKey,
				});
			},
			onError: (error) => {
				toast.error(error.message || "Failed to save the defaults");
			},
		}),
	);

	const fields = templateParameterFields(data?.templateParameters);
	const save = () => {
		if (!activeScope) {
			return;
		}
		saveMutation.mutate({
			templateId: template.id,
			projectId,
			scope: activeScope,
			defaults: defaultsFromDraft(
				draftFor(activeScope),
				savedFor(activeScope),
			),
		});
	};
	const formFor = (option: ReportDefaultsScope) => (
		<DefaultsForm
			scope={option}
			fields={fields}
			draft={draftFor(option)}
			scheduleLocked={
				option === "PROJECT" && data?.canSetProjectSchedule === false
			}
			onChange={updateDraft(option)}
		/>
	);

	const focusReturn = useDialogFocusReturn();

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent
				className="max-w-lg max-h-[90vh] overflow-y-auto"
				{...focusReturn}
			>
				<DialogHeader>
					<DialogTitle>Defaults for {template.name}</DialogTitle>
					<DialogDescription>
						New reports from this template start with these values.
						This project's defaults come before the organization's.
						Existing reports keep their own.
					</DialogDescription>
				</DialogHeader>

				{isLoading ? (
					<div className="flex justify-center py-8">
						<Spinner className="h-6 w-6" />
					</div>
				) : isError ? (
					<div className="space-y-2">
						<p role="alert" className="text-sm text-destructive">
							The defaults could not be loaded.
						</p>
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={isFetching}
							onClick={() => void refetch()}
						>
							<RotateCcwIcon className="mr-2 h-4 w-4" />
							Try again
						</Button>
					</div>
				) : !activeScope ? (
					<p className="text-sm text-muted-foreground">
						You can't change the defaults for this template.
					</p>
				) : editableScopes.length > 1 ? (
					<Tabs
						value={activeScope}
						onValueChange={(value) =>
							setScope(
								value === "ORGANIZATION"
									? "ORGANIZATION"
									: "PROJECT",
							)
						}
						className="space-y-5"
					>
						<TabsList>
							{editableScopes.map((option) => (
								<TabsTrigger key={option} value={option}>
									{SCOPE_LABEL[option]}
								</TabsTrigger>
							))}
						</TabsList>
						{editableScopes.map((option) => (
							<TabsContent key={option} value={option}>
								{formFor(option)}
							</TabsContent>
						))}
					</Tabs>
				) : (
					formFor(activeScope)
				)}

				{/* Only for those who may set that scope's defaults. */}
				{!isLoading &&
					!isError &&
					data?.canSetProject &&
					data.project?.prompts && (
						<PromptDefaults
							scope="PROJECT"
							prompts={data.project.prompts}
							showPrompts
							clearing={saveMutation.isPending}
							onClear={() =>
								saveMutation.mutate({
									templateId: template.id,
									projectId,
									scope: "PROJECT",
									defaults: defaultsWithoutPrompts(
										data.project,
									),
								})
							}
						/>
					)}
				{!isLoading &&
					!isError &&
					data?.canSetOrganization &&
					data.organization?.prompts && (
						<PromptDefaults
							scope="ORGANIZATION"
							prompts={data.organization.prompts}
							showPrompts={data.canSetOrganizationPrompts}
							clearing={saveMutation.isPending}
							onClear={() =>
								saveMutation.mutate({
									templateId: template.id,
									projectId,
									scope: "ORGANIZATION",
									defaults: defaultsWithoutPrompts(
										data.organization,
									),
								})
							}
						/>
					)}

				<DialogFooter>
					<Button variant="outline" onClick={onClose}>
						Close
					</Button>
					{activeScope && !isError && (
						<Button
							onClick={save}
							disabled={saveMutation.isPending}
						>
							{SAVE_LABEL[activeScope]}
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
