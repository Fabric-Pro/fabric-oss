"use client";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription } from "@ui/components/alert";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ui/components/alert-dialog";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { useId, useState } from "react";
import { toast } from "sonner";
import {
	type SkillDetail,
	skillAvailabilityLabel,
	skillUiError,
} from "../lib/skill-ui";
export function SkillAvailability({
	skill,
	organizationId,
	dirty = false,
	onChanged,
}: {
	skill: SkillDetail;
	organizationId: string;
	dirty?: boolean;
	onChanged?: () => void;
}) {
	const id = useId();
	const cache = useQueryClient();
	const [desired, setDesired] = useState<"draft" | "members" | "agents">(
		skill.availability === "agents"
			? "agents"
			: skill.availability === "members"
				? "members"
				: "draft",
	);
	const [confirm, setConfirm] = useState(false);
	const mutation = useMutation({
		mutationFn: () =>
			orpcClient.skills.publish({
				organizationId,
				id: skill.id,
				expectedVersion: skill.version,
				availability: desired,
			}),
		retry: false,
		onSuccess: async () => {
			toast.success("Skill availability updated");
			setConfirm(false);
			await cache.invalidateQueries({
				queryKey: ["skills", organizationId],
			});
			onChanged?.();
		},
	});
	if (skill.scope === "SYSTEM") {
		return (
			<p className="text-sm text-muted-foreground">
				Built-in skills are read-only. Use the instructions as a
				starting point for your own draft.
			</p>
		);
	}
	return (
		<section className="space-y-3" aria-label="Skill availability">
			<div className="flex flex-wrap items-center gap-2">
				<h2 className="text-base font-semibold">Availability</h2>
				<Badge variant="outline">
					{skill.archivedAt
						? "Archived"
						: skillAvailabilityLabel(skill.availability)}
				</Badge>
			</div>
			<p className="text-sm text-muted-foreground">
				Sharing a skill does not grant access to documents, project
				context, or connected tools. Each person and agent still needs
				the appropriate resource permissions.
			</p>
			{(skill.capabilities.canEdit || skill.capabilities.canUnpublish) &&
			!skill.archivedAt ? (
				<>
					<div className="flex flex-wrap items-end gap-3">
						<div className="min-w-0 flex-1 space-y-2">
							<Label htmlFor={id}>Who can find this skill?</Label>
							<Select
								value={desired}
								onValueChange={(v) =>
									setDesired(v as typeof desired)
								}
								disabled={dirty || mutation.isPending}
							>
								<SelectTrigger id={id}>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem
										value="draft"
										disabled={
											!skill.capabilities.canUnpublish
										}
									>
										Your draft
									</SelectItem>
									<SelectItem
										value="members"
										disabled={
											!skill.capabilities.canPublish
										}
									>
										Organization members
									</SelectItem>
									<SelectItem
										value="agents"
										disabled={
											!skill.capabilities.canDiscover
										}
									>
										Members and agent discovery
									</SelectItem>
								</SelectContent>
							</Select>
						</div>
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={
								dirty ||
								mutation.isPending ||
								desired === skill.availability
							}
							onClick={() => setConfirm(true)}
						>
							Update availability
						</Button>
					</div>
					{dirty && (
						<p className="text-xs text-muted-foreground">
							Save your changes before updating availability.
						</p>
					)}
					<p className="text-xs text-muted-foreground">
						Agent discovery allows eligible agents to find the
						published skill automatically. It does not grant
						credentials or execute its files.
					</p>
				</>
			) : (
				<p className="text-sm text-muted-foreground">
					Only this skill’s owner can change its availability, within
					the organization’s policy.
				</p>
			)}
			{mutation.isError && (
				<Alert variant="error">
					<AlertDescription>
						{skillUiError(mutation.error)}
					</AlertDescription>
				</Alert>
			)}
			<AlertDialog open={confirm} onOpenChange={setConfirm}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{desired === "draft"
								? "Make this skill a draft?"
								: "Share this skill?"}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{desired === "draft"
								? "It will be private to its owner and unavailable for new shared use."
								: desired === "agents"
									? "Organization members and eligible agents can discover this skill. Its instructions and files will be shared; source permissions remain unchanged."
									: "Organization members can find and use this skill. Its instructions and files will be shared; source permissions remain unchanged."}
						</AlertDialogDescription>
					</AlertDialogHeader>
					{mutation.isError && (
						<Alert variant="error">
							<AlertDescription>
								{skillUiError(mutation.error)}
							</AlertDescription>
						</Alert>
					)}
					<AlertDialogFooter>
						<AlertDialogCancel disabled={mutation.isPending}>
							Cancel
						</AlertDialogCancel>
						<AlertDialogAction
							disabled={mutation.isPending || dirty}
							onClick={(e) => {
								e.preventDefault();
								mutation.mutate();
							}}
						>
							{mutation.isPending
								? "Updating…"
								: "Confirm availability"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</section>
	);
}
