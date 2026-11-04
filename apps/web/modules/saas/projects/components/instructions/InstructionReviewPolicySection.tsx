"use client";

import { useInstructionActionError } from "@saas/projects/hooks/use-instruction-action-error";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { useTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";

const MAX_REQUIRED_APPROVALS = 10;

/**
 * The upload-mode proposal review policy: how many approvals publish a
 * proposal and, optionally, who may give them. Saved on its own, separately
 * from the ignore rules, and never offered for a repository-backed project,
 * whose proposals follow the provider's pull-request rules.
 *
 * The server checks every listed approver can review proposals and refuses
 * the save otherwise; the list offered here is the project's members.
 */
export function InstructionReviewPolicySection({
	projectId,
	open,
	canEdit,
}: {
	projectId: string;
	open: boolean;
	canEdit: boolean;
}) {
	const t = useTranslations(
		"projects.codingInstructions.settingsDialog.reviewPolicy",
	);
	const actionError = useInstructionActionError();
	const requiredId = useId();
	const hintId = useId();
	const queryClient = useQueryClient();
	const settingsOptions = orpc.projects.instructions.getSettings.queryOptions(
		{
			input: { projectId },
		},
	);
	const settings = useQuery({ ...settingsOptions, enabled: open });
	const members = useQuery({
		...orpc.projects.members.list.queryOptions({ input: { projectId } }),
		enabled: open && canEdit,
	});
	const [required, setRequired] = useState(1);
	const [restricted, setRestricted] = useState(false);
	const [approvers, setApprovers] = useState<string[]>([]);
	const [seeded, setSeeded] = useState(false);

	useEffect(() => {
		if (!open) {
			setSeeded(false);
			return;
		}
		const policy = settings.data?.reviewPolicy;
		if (policy && !seeded) {
			setRequired(policy.requiredApprovals);
			setRestricted(policy.approverUserIds !== null);
			setApprovers(policy.approverUserIds ?? []);
			setSeeded(true);
		}
	}, [open, seeded, settings.data]);

	const save = useMutation(
		orpc.projects.instructions.updateSettings.mutationOptions({
			onSuccess: () => {
				void queryClient.invalidateQueries({
					queryKey: settingsOptions.queryKey,
				});
				toast.success(t("saved"));
			},
			onError: (error) => toast.error(actionError(error)),
		}),
	);

	const memberList = members.data?.members ?? [];
	const tooFewApprovers = restricted && approvers.length < required;

	return (
		<fieldset
			className="flex flex-col gap-2 rounded-md border p-3"
			data-testid="instructions-review-policy"
		>
			<legend className="px-1 font-medium text-sm">{t("title")}</legend>
			<p id={hintId} className="text-muted-foreground text-xs">
				{t("description")}
			</p>
			<div className="flex items-center gap-2">
				<Label htmlFor={requiredId}>{t("requiredLabel")}</Label>
				<Input
					id={requiredId}
					type="number"
					min={1}
					max={MAX_REQUIRED_APPROVALS}
					className="w-20"
					aria-describedby={hintId}
					value={required}
					readOnly={!canEdit || !seeded}
					onChange={(event) =>
						setRequired(
							Math.min(
								MAX_REQUIRED_APPROVALS,
								Math.max(1, Number(event.target.value) || 1),
							),
						)
					}
				/>
			</div>
			{required > 1 ? (
				<p className="text-muted-foreground text-xs">
					{t("proposerExcluded")}
				</p>
			) : null}
			{canEdit ? (
				<div className="flex items-center gap-2">
					<Checkbox
						id={`${requiredId}-restricted`}
						checked={restricted}
						disabled={!seeded}
						onCheckedChange={(checked) =>
							setRestricted(checked === true)
						}
					/>
					<Label htmlFor={`${requiredId}-restricted`}>
						{t("restrictLabel")}
					</Label>
				</div>
			) : null}
			{canEdit && restricted ? (
				<ul className="flex max-h-40 flex-col gap-1 overflow-auto">
					{memberList.map((member) => {
						const id = `${requiredId}-${member.userId}`;
						return (
							<li
								key={member.userId}
								className="flex items-center gap-2"
							>
								<Checkbox
									id={id}
									checked={approvers.includes(member.userId)}
									onCheckedChange={(checked) =>
										setApprovers((current) =>
											checked === true
												? [...current, member.userId]
												: current.filter(
														(userId) =>
															userId !==
															member.userId,
													),
										)
									}
								/>
								<Label htmlFor={id} className="font-normal">
									{member.user.name ?? member.user.email}
								</Label>
							</li>
						);
					})}
				</ul>
			) : null}
			{tooFewApprovers ? (
				<p role="alert" className="text-destructive text-xs">
					{t("tooFewApprovers")}
				</p>
			) : null}
			{canEdit ? (
				<Button
					variant="outline"
					className="self-end"
					disabled={!seeded || save.isPending || tooFewApprovers}
					onClick={() =>
						save.mutate({
							projectId,
							reviewPolicy: {
								requiredApprovals: required,
								...(restricted
									? { approverUserIds: approvers }
									: {}),
							},
						})
					}
				>
					{t("save")}
				</Button>
			) : null}
		</fieldset>
	);
}
