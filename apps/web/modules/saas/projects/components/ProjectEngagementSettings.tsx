"use client";

import type { EngagementProfile } from "@repo/database/prisma/generated/enums";
import { ENGAGEMENT_PROFILES } from "@repo/database/src/engagement-profiles";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Avatar, AvatarFallback, AvatarImage } from "@ui/components/avatar";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import { Checkbox } from "@ui/components/checkbox";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { Switch } from "@ui/components/switch";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { Loader2Icon } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { EngagementProfilePicker } from "./wizard/EngagementProfilePicker";
import { parseCoreActions, VisionFields } from "./wizard/VisionFields";

type Project = {
	id: string;
	name: string;
	organizationId?: string | null;
	userRole?: string | null;
	/** Resolved server-side with the strict middleware-order permission check. */
	canManageGovernance?: boolean;
	engagementProfile?: EngagementProfile;
	engagementProfileUpdatedAt?: Date | string | null;
	enforceSpecifyGate?: boolean;
	enforceSpikeGate?: boolean;
	enforceDiscoveryGate?: boolean;
	documentTiersAdvisory?: boolean;
	quotedPhases?: string[];
	visionPurpose?: string | null;
	visionCoreActions?: string[];
	visionCycle?: string | null;
	stageApprovers?: Array<{ userId: string }>;
};

type Props = {
	project: Project;
};

type GateKey =
	| "enforceSpecifyGate"
	| "enforceSpikeGate"
	| "enforceDiscoveryGate"
	| "documentTiersAdvisory";

/** Gates whose run types do not exist yet — the server rejects `true`. */
const UNAVAILABLE_GATES: readonly GateKey[] = [
	// Spike (Slice 3) and discovery (Slice 4) runs now exist, so every gate can
	// be switched on. The list stays as the hook for gating future run types.
];

const GATE_KEYS: readonly GateKey[] = [
	"enforceSpecifyGate",
	"enforceSpikeGate",
	"enforceDiscoveryGate",
	"documentTiersAdvisory",
];

function sameStringArray(a: readonly string[], b: readonly string[]) {
	return (
		a.length === b.length && a.every((value, index) => value === b[index])
	);
}

/**
 * "Engagement" section of project settings: profile, enforcement flags,
 * quoted phases, vision, and stage approvers. Governance controls are
 * disabled unless the server says the caller holds
 * `project:governance:manage`; vision stays editable with `project:update`.
 * UI gating is a convenience — `projects.update` and
 * `governance.setStageApprovers` enforce the permission server-side.
 */
export function ProjectEngagementSettings({ project }: Props) {
	const t = useTranslations("projects.engagement");
	const tTooltips = useTranslations("tooltips.projectSettings");
	const format = useFormatter();
	const queryClient = useQueryClient();
	const id = useId();

	const canManage =
		project.canManageGovernance ?? project.userRole === "owner";

	const initialProfile: EngagementProfile =
		project.engagementProfile ?? "GOVERNED";
	const initialGates: Record<GateKey, boolean> = {
		enforceSpecifyGate: project.enforceSpecifyGate ?? false,
		enforceSpikeGate: project.enforceSpikeGate ?? false,
		enforceDiscoveryGate: project.enforceDiscoveryGate ?? false,
		documentTiersAdvisory: project.documentTiersAdvisory ?? false,
	};
	const initialQuotedPhases = project.quotedPhases ?? [];
	const initialVision = {
		visionPurpose: project.visionPurpose ?? "",
		visionCoreActions: project.visionCoreActions ?? [],
		visionCycle: project.visionCycle ?? "",
	};

	const [profile, setProfile] = useState<EngagementProfile>(initialProfile);
	const [gates, setGates] = useState(initialGates);
	const [quotedPhasesText, setQuotedPhasesText] = useState(
		initialQuotedPhases.join(", "),
	);
	const [vision, setVision] = useState(initialVision);

	// Sync from the parent when the project changes (query refetch).
	useEffect(() => {
		setProfile(initialProfile);
		setGates(initialGates);
		setQuotedPhasesText(initialQuotedPhases.join(", "));
		setVision(initialVision);
	}, [
		project.engagementProfile,
		project.enforceSpecifyGate,
		project.enforceSpikeGate,
		project.enforceDiscoveryGate,
		project.documentTiersAdvisory,
		project.quotedPhases,
		project.visionPurpose,
		project.visionCoreActions,
		project.visionCycle,
	]);

	const quotedPhases = useMemo(
		() => parseCoreActions(quotedPhasesText),
		[quotedPhasesText],
	);

	const governanceChanged =
		profile !== initialProfile ||
		GATE_KEYS.some((key) => gates[key] !== initialGates[key]) ||
		!sameStringArray(quotedPhases, initialQuotedPhases);
	const visionChanged =
		vision.visionPurpose !== initialVision.visionPurpose ||
		vision.visionCycle !== initialVision.visionCycle ||
		!sameStringArray(
			vision.visionCoreActions,
			initialVision.visionCoreActions,
		);
	const hasChanges = (canManage && governanceChanged) || visionChanged;

	const updateMutation = useMutation({
		mutationFn: async () => {
			return await orpcClient.projects.update({
				id: project.id,
				organizationId: project.organizationId,
				// Governance fields only when the caller may change them;
				// sending unchanged values would still trigger the server check.
				...(canManage && governanceChanged
					? {
							engagementProfile: profile,
							enforceSpecifyGate: gates.enforceSpecifyGate,
							enforceSpikeGate: gates.enforceSpikeGate,
							enforceDiscoveryGate: gates.enforceDiscoveryGate,
							documentTiersAdvisory: gates.documentTiersAdvisory,
							quotedPhases,
						}
					: {}),
				...(visionChanged
					? {
							visionPurpose: vision.visionPurpose.trim() || null,
							visionCoreActions: vision.visionCoreActions,
							visionCycle: vision.visionCycle.trim() || null,
						}
					: {}),
			});
		},
		onSuccess: () => {
			toast.success(t("saved"));
			// Refetch the project so the form re-hydrates from the saved row
			// (clears "Unsaved changes") and the roadmap/tabs see the new
			// profile. Same key the other settings panels invalidate.
			queryClient.invalidateQueries({
				queryKey: orpc.projects.get.queryKey({
					input: {
						id: project.id,
						organizationId: project.organizationId,
					},
				}),
			});
		},
		onError: (error) => {
			toast.error(
				error instanceof Error ? error.message : "Failed to save",
			);
		},
	});

	const handleReset = () => {
		setProfile(initialProfile);
		setGates(initialGates);
		setQuotedPhasesText(initialQuotedPhases.join(", "));
		setVision(initialVision);
	};

	// ---- Stage approvers -------------------------------------------------
	const membersQuery = useQuery(
		orpc.projects.members.list.queryOptions({
			input: {
				projectId: project.id,
				organizationId: project.organizationId ?? null,
			},
		}),
	);
	const approversQuery = useQuery(
		orpc.projects.governance.listStageApprovers.queryOptions({
			input: {
				projectId: project.id,
				organizationId: project.organizationId ?? null,
			},
		}),
	);

	const serverApproverIds = useMemo(
		() =>
			(approversQuery.data?.approvers ?? project.stageApprovers ?? [])
				.map((approver) => approver.userId)
				.sort(),
		[approversQuery.data, project.stageApprovers],
	);
	const [approverIds, setApproverIds] = useState<string[]>(serverApproverIds);
	useEffect(() => {
		setApproverIds(serverApproverIds);
	}, [serverApproverIds]);

	const approversChanged = !sameStringArray(
		[...approverIds].sort(),
		serverApproverIds,
	);

	const approversMutation = useMutation({
		mutationFn: async () => {
			return await orpcClient.projects.governance.setStageApprovers({
				projectId: project.id,
				organizationId: project.organizationId ?? null,
				userIds: approverIds,
			});
		},
		onSuccess: () => {
			toast.success(t("approvers.saved"));
			queryClient.invalidateQueries({
				queryKey: orpc.projects.governance.listStageApprovers.queryKey({
					input: {
						projectId: project.id,
						organizationId: project.organizationId ?? null,
					},
				}),
			});
			queryClient.invalidateQueries({
				queryKey: orpc.projects.get.queryKey({
					input: {
						id: project.id,
						organizationId: project.organizationId,
					},
				}),
			});
		},
		onError: (error) => {
			toast.error(
				error instanceof Error ? error.message : "Failed to save",
			);
		},
	});

	const toggleApprover = (userId: string) => {
		setApproverIds((prev) =>
			prev.includes(userId)
				? prev.filter((existing) => existing !== userId)
				: [...prev, userId],
		);
	};

	const eligibleMembers = membersQuery.data?.members ?? [];
	const profileConfig = ENGAGEMENT_PROFILES[profile];
	const profileUpdatedAt = project.engagementProfileUpdatedAt
		? new Date(project.engagementProfileUpdatedAt)
		: null;

	return (
		<div className="space-y-6">
			<div>
				<p className="text-[11px] font-medium uppercase tracking-[0.22em] text-muted-foreground">
					{t("sectionLabel")}
				</p>
				<h3 className="mt-2 text-xl font-semibold text-foreground">
					{t("title")}
				</h3>
				<p className="mt-2 max-w-3xl text-sm text-muted-foreground">
					{t("description")}
				</p>
				{!canManage && (
					<p
						className="mt-3 rounded-lg border border-border bg-muted px-3 py-2 text-sm text-muted-foreground"
						role="note"
					>
						{t("readOnly")}
					</p>
				)}
			</div>

			{/* Profile */}
			<Card className="p-6">
				<EngagementProfilePicker
					value={profile}
					onChange={setProfile}
					disabled={!canManage}
					columns={2}
				/>
				{profileUpdatedAt && (
					<p className="mt-4 text-xs text-muted-foreground">
						{t("profileUpdatedAt", {
							date: format.dateTime(profileUpdatedAt, {
								dateStyle: "medium",
							}),
						})}
					</p>
				)}
			</Card>

			{/* Enforcement flags + quoted phases */}
			<Card className="p-6">
				<div className="space-y-5">
					<div>
						<Label className="text-base font-medium">
							{t("gates.title")}
						</Label>
						<p className="mt-1 text-sm text-muted-foreground">
							{t("gates.description")}
						</p>
					</div>

					<ul className="divide-y divide-border">
						{GATE_KEYS.map((key) => {
							const unavailable = UNAVAILABLE_GATES.includes(key);
							const disabled = !canManage || unavailable;
							const switchId = `${id}-${key}`;
							const control = (
								<Switch
									id={switchId}
									checked={gates[key]}
									disabled={disabled}
									onCheckedChange={(checked) =>
										setGates((prev) => ({
											...prev,
											[key]: checked,
										}))
									}
									aria-describedby={`${switchId}-hint`}
								/>
							);
							return (
								<li
									key={key}
									className="flex items-start justify-between gap-4 py-3"
								>
									<div className="min-w-0">
										<Label
											htmlFor={switchId}
											className="font-medium"
										>
											{t(`gates.${key}`)}
										</Label>
										<p
											id={`${switchId}-hint`}
											className="mt-0.5 text-sm text-muted-foreground"
										>
											{t(`gates.${key}Hint`)}
											{unavailable && (
												<>
													{" "}
													<span className="text-highlight">
														{t(
															"gates.unavailableUntilRuns",
														)}
													</span>
												</>
											)}
										</p>
									</div>
									{unavailable ? (
										<Tooltip>
											<TooltipTrigger asChild>
												{/* Hover affordance only; the same text is
												    visible inline for keyboard/screen-reader users
												    because a disabled switch cannot take focus. */}
												<span className="inline-flex rounded-full">
													{control}
												</span>
											</TooltipTrigger>
											<TooltipContent side="left">
												{t(
													"gates.unavailableUntilRuns",
												)}
											</TooltipContent>
										</Tooltip>
									) : (
										control
									)}
								</li>
							);
						})}
					</ul>

					<div className="space-y-2 border-t border-border pt-5">
						<Label htmlFor={`${id}-phases`}>
							{t("quotedPhases")}
						</Label>
						<Input
							id={`${id}-phases`}
							value={quotedPhasesText}
							onChange={(event) =>
								setQuotedPhasesText(event.target.value)
							}
							placeholder={t("quotedPhasesPlaceholder")}
							disabled={!canManage}
							aria-describedby={`${id}-phases-hint`}
						/>
						<p
							id={`${id}-phases-hint`}
							className="text-xs text-muted-foreground"
						>
							{t("quotedPhasesHint")}
						</p>
					</div>
				</div>
			</Card>

			{/* Vision */}
			<Card className="p-6">
				<VisionFields
					visionPurpose={vision.visionPurpose}
					visionCoreActions={vision.visionCoreActions}
					visionCycle={vision.visionCycle}
					onChange={(updates) =>
						setVision((prev) => ({ ...prev, ...updates }))
					}
				/>
			</Card>

			{/* Save bar for profile / flags / vision */}
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
						<TooltipContent>
							{tTooltips("discardChanges")}
						</TooltipContent>
					</Tooltip>
					<Button
						size="sm"
						onClick={() => updateMutation.mutate()}
						disabled={updateMutation.isPending}
					>
						{updateMutation.isPending ? (
							<>
								<Loader2Icon className="mr-2 size-4 animate-spin" />
								Saving...
							</>
						) : (
							t("save")
						)}
					</Button>
				</div>
			)}

			{/* Stage approvers */}
			<Card className="p-6">
				<div className="space-y-4">
					<div>
						<Label className="text-base font-medium">
							{t("approvers.title")}
						</Label>
						<p className="mt-1 text-sm text-muted-foreground">
							{t("approvers.description")}
						</p>
						{profileConfig.stageTransitionsRequireReview &&
							serverApproverIds.length === 0 && (
								<p className="mt-2 text-sm text-highlight">
									{t("approvers.empty")}
								</p>
							)}
					</div>

					{membersQuery.isLoading || approversQuery.isLoading ? (
						<div className="flex items-center gap-2 text-sm text-muted-foreground">
							<Loader2Icon className="size-4 animate-spin" />
							Loading members...
						</div>
					) : eligibleMembers.length === 0 ? (
						<p className="text-sm text-muted-foreground">
							{t("approvers.noEligible")}
						</p>
					) : (
						<ul className="divide-y divide-border rounded-lg border border-border">
							{eligibleMembers.map((member) => {
								const checkboxId = `${id}-approver-${member.userId}`;
								const checked = approverIds.includes(
									member.userId,
								);
								return (
									<li
										key={member.userId}
										className="flex items-center gap-3 px-3 py-2.5"
									>
										<Checkbox
											id={checkboxId}
											checked={checked}
											disabled={!canManage}
											onCheckedChange={() =>
												toggleApprover(member.userId)
											}
										/>
										<Avatar className="size-7">
											<AvatarImage
												src={
													member.user.image ??
													undefined
												}
												alt=""
											/>
											<AvatarFallback className="text-xs">
												{(
													member.user.name ??
													member.user.email
												)
													.slice(0, 2)
													.toUpperCase()}
											</AvatarFallback>
										</Avatar>
										<Label
											htmlFor={checkboxId}
											className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 font-normal"
										>
											<span className="truncate text-sm text-foreground">
												{member.user.name ??
													member.user.email}
											</span>
											<span className="truncate text-xs text-muted-foreground">
												{member.user.email} ·{" "}
												{member.role}
											</span>
										</Label>
									</li>
								);
							})}
						</ul>
					)}

					{canManage && approversChanged && (
						<div className="flex justify-end gap-3">
							<Button
								variant="outline"
								size="sm"
								onClick={() =>
									setApproverIds(serverApproverIds)
								}
							>
								Discard
							</Button>
							<Button
								size="sm"
								onClick={() => approversMutation.mutate()}
								disabled={approversMutation.isPending}
							>
								{approversMutation.isPending ? (
									<>
										<Loader2Icon className="mr-2 size-4 animate-spin" />
										Saving...
									</>
								) : (
									t("approvers.save")
								)}
							</Button>
						</div>
					)}
				</div>
			</Card>
		</div>
	);
}
