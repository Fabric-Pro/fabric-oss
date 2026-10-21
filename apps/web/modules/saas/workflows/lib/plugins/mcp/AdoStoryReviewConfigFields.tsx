"use client";

import {
	ADO_REVIEW_MAX_STORIES,
	type AdoStoryReviewConfig,
	adoStoryReviewConfigFieldsSchema,
	adoStoryReviewConfigSchema,
} from "@repo/temporal/ado-story-review-config";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Switch } from "@ui/components/switch";
import { Textarea } from "@ui/components/textarea";
import { useId } from "react";
import { z } from "zod";
import { AiModelSelector } from "../../../components/config-fields/AiModelSelector";
import type { ActionConfigComponentProps } from "../types";
import { AdoReviewInstructionFields } from "./AdoReviewInstructionFields";

const fields = adoStoryReviewConfigFieldsSchema.shape;
const draftAssignee = z.discriminatedUnion("mode", [
	z.object({ mode: z.literal("current") }),
	z.object({ mode: z.literal("selected"), uniqueName: z.string() }),
]);
const draftSkills = z.array(
	z.object({ slug: z.string(), textFiles: z.array(z.string()).default([]) }),
);

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function lines(value: unknown, fallback: string[]): string {
	return Array.isArray(value)
		? value
				.filter((item): item is string => typeof item === "string")
				.join("\n")
		: fallback.join("\n");
}

export function AdoStoryReviewConfigFields({
	config,
	onChange,
}: ActionConfigComponentProps) {
	const id = useId();
	const selectedAssignee = draftAssignee.safeParse(config.assignee);
	const assignee: AdoStoryReviewConfig["assignee"] = selectedAssignee.success
		? selectedAssignee.data
		: { mode: "current" };
	const skillSelection = draftSkills.safeParse(config.skills);
	const skills = skillSelection.success ? skillSelection.data : [];
	const update = (patch: Record<string, unknown>) =>
		onChange({ ...config, assignee, ...patch });
	const validation = adoStoryReviewConfigSchema.safeParse({
		...config,
		assignee,
	});
	const maxStories =
		typeof config.maxStories === "number"
			? Number.isFinite(config.maxStories)
				? config.maxStories
				: ""
			: fields.maxStories.parse(undefined);
	const sprint = z
		.record(z.string(), z.unknown())
		.safeParse(config.sprintContext);
	const sprintDraft = sprint.success ? sprint.data : null;
	const sprintFields = [
		[
			"iterationPaths",
			"Exact iteration paths (one or two, one per line)",
			2,
		],
		[
			"assignmentFields",
			"Assignment fields (any field reference name, e.g. System.AssignedTo or Custom.BEEngineer, one per line)",
			2,
		],
		["assignedItemTypes", "Assigned task types (one per line)", 3],
		[
			"parentSourceTypes",
			"Assigned types whose parents are followed (one per line)",
			3,
		],
		[
			"relationKinds",
			"Immediate context relations (child or related, one per line)",
			2,
		],
		[
			"excludedAssignedStates",
			"Excluded assigned states (optional, one per line)",
			2,
		],
	] as const;

	return (
		<div className="space-y-4">
			<p className="text-sm text-muted-foreground">
				Reads the workflow's attached Azure DevOps project using the
				workflow owner's connection. Requirements and comments that have
				not changed reuse their previous completed review. Manual runs
				can request a fresh review.
			</p>
			<div className="flex items-center gap-2">
				<Switch
					id={`${id}-sprint`}
					checked={config.sprintContext !== undefined}
					onCheckedChange={(enabled) => {
						const next: Record<string, unknown> = {
							...config,
							assignee,
						};
						if (enabled) {
							next.sprintContext = {
								iterationPaths: [],
								assignmentFields: ["System.AssignedTo"],
								assignedItemTypes: ["Task"],
								parentSourceTypes: ["Task"],
								relationKinds: ["child", "related"],
								excludedAssignedStates: [],
							};
						} else {
							delete next.sprintContext;
						}
						onChange(next);
					}}
				/>
				<Label htmlFor={`${id}-sprint`}>
					Use sprint tasks and linked story context
				</Label>
			</div>
			{config.sprintContext !== undefined && (
				<fieldset className="space-y-4">
					<legend className="text-sm font-medium">
						Sprint selection
					</legend>
					<p className="text-xs text-muted-foreground">
						Exact paths stay fixed until edited. Target story types
						use the Work item types field below. Parent sources must
						be among the assigned task types. Context includes
						immediate child and Related items with their comments.
						If an assignment field does not support @Me, select an
						exact ADO member unique name.
					</p>
					{sprintFields.map(([key, label, rows]) => (
						<div className="space-y-2" key={key}>
							<Label htmlFor={`${id}-${key}`}>{label}</Label>
							<Textarea
								id={`${id}-${key}`}
								rows={rows}
								value={lines(sprintDraft?.[key], [])}
								onChange={(event) =>
									update({
										sprintContext: {
											...sprintDraft,
											[key]:
												event.target.value === ""
													? []
													: event.target.value.split(
															"\n",
														),
										},
									})
								}
							/>
						</div>
					))}
				</fieldset>
			)}
			<div className="space-y-2">
				<Label htmlFor={`${id}-assignee`}>Assigned to</Label>
				<Select
					value={assignee.mode}
					onValueChange={(value) =>
						update({
							assignee:
								value === "current"
									? { mode: "current" }
									: { mode: "selected", uniqueName: "" },
						})
					}
				>
					<SelectTrigger id={`${id}-assignee`}>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="current">
							My connected ADO account (@Me)
						</SelectItem>
						<SelectItem value="selected">
							A selected ADO member
						</SelectItem>
					</SelectContent>
				</Select>
			</div>
			{assignee.mode === "selected" && (
				<div className="space-y-2">
					<Label htmlFor={`${id}-member`}>
						ADO member unique name
					</Label>
					<Input
						id={`${id}-member`}
						value={assignee.uniqueName}
						maxLength={512}
						placeholder="member@example.com"
						onChange={(event) =>
							update({
								assignee: {
									mode: "selected",
									uniqueName: event.target.value,
								},
							})
						}
					/>
					<p className="text-xs text-muted-foreground">
						Use the member's ADO unique name. The filter stays
						inside the attached project.
					</p>
				</div>
			)}
			<div className="space-y-2">
				<Label htmlFor={`${id}-types`}>
					Work item types (one per line)
				</Label>
				<Textarea
					id={`${id}-types`}
					rows={2}
					value={lines(
						config.workItemTypes,
						fields.workItemTypes.parse(undefined),
					)}
					onChange={(event) =>
						update({
							workItemTypes: event.target.value.split("\n"),
						})
					}
				/>
			</div>
			<div className="space-y-2">
				<Label htmlFor={`${id}-fields`}>
					Requirement field reference names (one per line)
				</Label>
				<Textarea
					id={`${id}-fields`}
					rows={3}
					value={lines(
						config.requirementFields,
						fields.requirementFields.parse(undefined),
					)}
					onChange={(event) =>
						update({
							requirementFields: event.target.value.split("\n"),
						})
					}
				/>
			</div>
			<AiModelSelector
				value={text(config.model)}
				onChange={(model) => update({ model: model || undefined })}
				label="Review model (optional override)"
				placeholder="Use agent preference or configured default"
			/>
			{text(config.model) && (
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => update({ model: undefined })}
				>
					Use agent preference or default model
				</Button>
			)}
			<AdoReviewInstructionFields
				agentId={text(config.agentInstructionsInstanceId)}
				skills={skills}
				onAgentChange={(agentInstructionsInstanceId) =>
					update({ agentInstructionsInstanceId })
				}
				onSkillsChange={(nextSkills) => update({ skills: nextSkills })}
			/>
			<div className="space-y-2">
				<Label htmlFor={`${id}-rubric`}>Review criteria</Label>
				<Textarea
					id={`${id}-rubric`}
					rows={6}
					maxLength={16_000}
					value={text(config.rubric)}
					onChange={(event) => update({ rubric: event.target.value })}
					placeholder="Describe what makes a requirement complete and the issues the review should flag."
				/>
			</div>
			<div className="space-y-2">
				<Label htmlFor={`${id}-max`}>Maximum stories per run</Label>
				<Input
					id={`${id}-max`}
					type="number"
					min={1}
					max={ADO_REVIEW_MAX_STORIES}
					step={1}
					value={maxStories}
					onChange={(event) =>
						update({ maxStories: event.target.valueAsNumber })
					}
				/>
				<p className="text-xs text-muted-foreground">
					If the assignment exceeds this limit, the run stops before
					generating reviews.
				</p>
			</div>
			<div className="space-y-2">
				<Label htmlFor={`${id}-workspace`}>
					Parent Workspace ID (optional)
				</Label>
				<Input
					id={`${id}-workspace`}
					value={text(config.workspaceFrameId)}
					onChange={(event) =>
						update({
							workspaceFrameId: event.target.value || undefined,
						})
					}
				/>
				<p className="text-xs text-muted-foreground">
					Attributes AI usage to your Workspace. It must belong to
					this organization and have the same project, or no project.
				</p>
			</div>
			{!validation.success && (
				<ul
					aria-label="Review configuration problems"
					className="list-disc space-y-1 pl-4 text-xs text-destructive"
				>
					{validation.error.issues.map((issue, index) => (
						<li key={`${issue.path.join(".")}-${index}`}>
							{issue.path.join(".")}: {issue.message}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
