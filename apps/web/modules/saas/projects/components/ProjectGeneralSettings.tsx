"use client";

import {
	MAX_ATTACHMENT_RETENTION_DAYS,
	MIN_ATTACHMENT_RETENTION_DAYS,
	parseRetentionDaysInput,
} from "@repo/utils/attachment";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { Loader2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

type Project = {
	id: string;
	name: string;
	organizationId?: string | null;
	/** Which readiness checklist grades this project; null means Fabric infers one (#2165). */
	projectPhase?: "DISCOVERY_PLANNING" | "DEVELOPMENT_EXECUTION" | null;
	expectedDevelopmentStartDate?: string | Date | null;
	/** Project-level retention override in days; null = inherit (Fizzy #1749). */
	attachmentRetentionDays?: number | null;
	/**
	 * What the purge would actually apply right now, resolved server-side
	 * through project -> organization -> server default. Rendered as the
	 * placeholder so the browser never holds its own copy of the default.
	 */
	effectiveAttachmentRetentionDays?: number;
	canEditSettings?: boolean;
};

type Props = {
	project: Project;
};

export function ProjectGeneralSettings({ project }: Props) {
	const queryClient = useQueryClient();
	const t = useTranslations("tooltips.projectSettings");

	const [name, setName] = useState(project.name);
	const [projectPhase, setProjectPhase] = useState<
		"DISCOVERY_PLANNING" | "DEVELOPMENT_EXECUTION" | ""
	>(project.projectPhase ?? "");
	const [expectedStart, setExpectedStart] = useState(
		project.expectedDevelopmentStartDate
			? new Date(project.expectedDevelopmentStartDate)
					.toISOString()
					.slice(0, 10)
			: "",
	);
	// Held as a string, not a number: an empty field means "inherit", which is
	// a distinct state from any numeric value and would be lost to NaN.
	const [retentionDays, setRetentionDays] = useState<string>(
		project.attachmentRetentionDays?.toString() ?? "",
	);
	// Read at save time rather than remembered from onChange: `validity` is live
	// state on the element, and the failure mode this guards is precisely a
	// value that does not describe what was entered.
	const retentionInputRef = useRef<HTMLInputElement>(null);

	// Sync from parent when project changes
	useEffect(() => {
		setName(project.name);
		setProjectPhase(project.projectPhase ?? "");
		setExpectedStart(
			project.expectedDevelopmentStartDate
				? new Date(project.expectedDevelopmentStartDate)
						.toISOString()
						.slice(0, 10)
				: "",
		);
		setRetentionDays(project.attachmentRetentionDays?.toString() ?? "");
	}, [
		project.name,
		project.projectPhase,
		project.expectedDevelopmentStartDate,
		project.attachmentRetentionDays,
	]);

	const initialExpectedStart = project.expectedDevelopmentStartDate
		? new Date(project.expectedDevelopmentStartDate)
				.toISOString()
				.slice(0, 10)
		: "";

	const hasChanges =
		name !== project.name ||
		projectPhase !== (project.projectPhase ?? "") ||
		expectedStart !== initialExpectedStart ||
		retentionDays !== (project.attachmentRetentionDays?.toString() ?? "");

	const updateMutation = useMutation({
		mutationFn: async () => {
			// Sent verbatim. Deliberately NOT clamped to the allowed range: the
			// server is the single validation authority and rejects an
			// out-of-range value, which surfaces in the error toast.
			//
			// But an entry that cannot be sent must never reach the wire, and
			// there are two ways to have one. JSON turns NaN and Infinity into
			// `null`; and a number input reports `value === ""` for an entry it
			// could not parse while still SHOWING the text, so a blank field can
			// mean "I typed something unusable" rather than "inherit". `null` is
			// a VALID input here meaning "clear the override", so either would
			// silently wipe a configured window and stamp the change timestamp,
			// re-arming the grace floor. Only `validity.badInput` separates the
			// two blanks. Refuse instead; the throw lands in onError as a toast.
			const nextRetentionDays = parseRetentionDaysInput(retentionDays, {
				badInput: retentionInputRef.current?.validity.badInput,
			});
			if (nextRetentionDays === undefined) {
				throw new Error(
					"Attachment retention must be a number of days, or blank to inherit.",
				);
			}
			return await orpcClient.projects.update({
				id: project.id,
				organizationId: project.organizationId,
				name: name.trim(),
				// "" means the user chose no phase — send null to clear it rather
				// than undefined, which the API reads as "leave alone".
				projectPhase: projectPhase === "" ? null : projectPhase,
				expectedDevelopmentStartDate:
					projectPhase === "DISCOVERY_PLANNING" && expectedStart
						? new Date(expectedStart)
						: null,
				attachmentRetentionDays: nextRetentionDays,
			});
		},
		onSuccess: () => {
			toast.success("Project updated");
			queryClient.invalidateQueries({
				queryKey: ["projects", project.id],
			});
		},
		onError: (error) => {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to update project",
			);
		},
	});

	const handleReset = useCallback(() => {
		setName(project.name);
		setProjectPhase(project.projectPhase ?? "");
		setExpectedStart(
			project.expectedDevelopmentStartDate
				? new Date(project.expectedDevelopmentStartDate)
						.toISOString()
						.slice(0, 10)
				: "",
		);
		setRetentionDays(project.attachmentRetentionDays?.toString() ?? "");
	}, [project]);

	return (
		<div className="space-y-6">
			{/* Name & Identity */}
			<Card className="p-6">
				<div className="space-y-5">
					<div className="space-y-2">
						<Label htmlFor="project-name">Project Name</Label>
						<Input
							id="project-name"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="My Project"
							maxLength={255}
						/>
					</div>

					{/* Project phase (Fizzy #2165). Lives here because the readiness
					    checklist's own "Project phase selected" row points at Project
					    Settings — and because every project predating readiness has
					    no phase, so without this control they could only ever be graded
					    on an inferred one
					    and the readiness panel never appears for them. */}
					<div className="space-y-2">
						<Label htmlFor="project-phase">Project phase</Label>
						<select
							id="project-phase"
							value={projectPhase}
							onChange={(e) =>
								setProjectPhase(
									e.target.value as typeof projectPhase,
								)
							}
							className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
						>
							<option value="">Not set</option>
							<option value="DISCOVERY_PLANNING">
								Discovery / Planning
							</option>
							<option value="DEVELOPMENT_EXECUTION">
								Development / Execution
							</option>
						</select>
						<p className="text-muted-foreground text-sm">
							Decides which readiness checklist applies — the two
							phases weight the same items differently. Leave it
							unset and Fabric works one out from the project,
							marking it as assumed until you choose.
						</p>
					</div>

					{projectPhase === "DISCOVERY_PLANNING" && (
						<div className="space-y-2">
							<Label htmlFor="project-expected-start">
								Expected development start date
							</Label>
							<Input
								id="project-expected-start"
								type="date"
								value={expectedStart}
								onChange={(e) =>
									setExpectedStart(e.target.value)
								}
							/>
							<p className="text-muted-foreground text-sm">
								Optional. Used to de&#8209;emphasise codebase
								items until development is expected to begin.
							</p>
						</div>
					)}
				</div>
			</Card>

			{/* Attachment retention */}
			<Card className="p-6">
				<div className="space-y-2">
					<Label htmlFor="attachment-retention">
						Attachment retention (days)
					</Label>
					<Input
						ref={retentionInputRef}
						id="attachment-retention"
						type="number"
						min={MIN_ATTACHMENT_RETENTION_DAYS}
						max={MAX_ATTACHMENT_RETENTION_DAYS}
						inputMode="numeric"
						value={retentionDays}
						disabled={project.canEditSettings === false}
						placeholder={
							project.effectiveAttachmentRetentionDays
								? String(
										project.effectiveAttachmentRetentionDays,
									)
								: "Default"
						}
						onChange={(e) => setRetentionDays(e.target.value)}
					/>
					<p className="text-xs text-muted-foreground">
						How long removed attachments are kept before they are
						permanently deleted. Leave blank to inherit. A change
						applies to already-removed attachments after a 7-day
						grace period, and deletion cannot be undone.
					</p>
				</div>
			</Card>

			{/* Save bar */}
			{hasChanges && (
				<div className="sticky bottom-4 flex items-center justify-end gap-3 rounded-xl border border-border bg-card p-4 shadow-lg">
					<p className="mr-auto text-sm text-muted-foreground">
						Unsaved changes
					</p>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="outline"
								size="sm"
								onClick={handleReset}
							>
								Discard
							</Button>
						</TooltipTrigger>
						<TooltipContent>{t("discardChanges")}</TooltipContent>
					</Tooltip>
					<Button
						size="sm"
						onClick={() => updateMutation.mutate()}
						disabled={updateMutation.isPending || !name.trim()}
					>
						{updateMutation.isPending ? (
							<>
								<Loader2Icon className="size-4 mr-2 animate-spin" />
								Saving...
							</>
						) : (
							"Save Changes"
						)}
					</Button>
				</div>
			)}
		</div>
	);
}
