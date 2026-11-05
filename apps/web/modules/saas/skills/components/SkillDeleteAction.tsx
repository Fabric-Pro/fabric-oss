"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription } from "@ui/components/alert";
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
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { MoreHorizontalIcon, Trash2Icon } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import type { SkillDetail } from "../lib/skill-ui";

export function SkillDeleteAction({
	skill,
	organizationId,
	disabled = false,
	onDeleted,
}: {
	skill: SkillDetail;
	organizationId: string;
	disabled?: boolean;
	onDeleted: () => void;
}) {
	const id = useId();
	const cache = useQueryClient();
	const [intent, setIntent] = useState<{
		id: string;
		name: string;
		version: number;
	}>();
	const [typed, setTyped] = useState("");
	const [refreshing, setRefreshing] = useState(false);
	const remove = useMutation({
		mutationFn: () => {
			if (
				!intent ||
				intent.id !== skill.id ||
				intent.version !== skill.version ||
				typed !== intent.name ||
				!skill.capabilities.canDelete ||
				disabled
			) {
				throw new Error("Review the current skill before deleting it.");
			}
			return orpcClient.skills.delete({
				organizationId,
				id: skill.id,
				expectedVersion: intent.version,
			});
		},
		retry: false,
		onSuccess: async () => {
			toast.success("Skill permanently deleted");
			setIntent(undefined);
			await cache.invalidateQueries({
				queryKey: ["skills", organizationId],
				predicate: (query) => query.queryKey[2] !== "detail",
			});
			onDeleted();
		},
	});
	async function refresh() {
		setRefreshing(true);
		try {
			const { skill: current } = await cache.fetchQuery({
				queryKey: ["skills", organizationId, "detail", skill.id],
				queryFn: () =>
					orpcClient.skills.get({ organizationId, id: skill.id }),
				staleTime: 0,
				retry: false,
			});
			setIntent({
				id: current.id,
				name: current.name,
				version: current.version,
			});
			setTyped("");
			remove.reset();
		} catch {
			// The authorized detail query owns its unavailable/error state. Never
			// turn a failed refresh into permission to retry an uncertain write.
		} finally {
			setRefreshing(false);
		}
	}
	if (!skill.capabilities.canDelete) {
		return null;
	}
	const changed =
		!!intent &&
		(intent.id !== skill.id || intent.version !== skill.version);
	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						type="button"
						variant="ghost"
						size="icon"
						aria-label="Skill actions"
						disabled={disabled || remove.isPending}
					>
						<MoreHorizontalIcon className="size-4" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<DropdownMenuItem
						className="text-destructive focus:text-destructive"
						onSelect={() => {
							setTyped("");
							if (!remove.isError) {
								remove.reset();
							}
							setIntent({
								id: skill.id,
								name: skill.name,
								version: skill.version,
							});
						}}
					>
						<Trash2Icon className="size-4" />
						Delete permanently
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<AlertDialog
				open={!!intent}
				onOpenChange={(open) => {
					if (!open && !remove.isPending && !refreshing) {
						setIntent(undefined);
					}
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle className="break-words">
							Delete {intent?.name} permanently?
						</AlertDialogTitle>
						<AlertDialogDescription>
							Agents will no longer be able to use this skill.
							This cannot be undone. You are reviewing saved
							version {intent?.version}.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<div className="space-y-2">
						<Label htmlFor={id}>
							Type the skill name to confirm
						</Label>
						<Input
							id={id}
							value={typed}
							onChange={(event) => setTyped(event.target.value)}
							autoComplete="off"
							disabled={remove.isPending || refreshing}
						/>
					</div>
					{changed && (
						<p className="text-sm text-muted-foreground">
							This skill changed. Close this dialog and review the
							current version before deleting it.
						</p>
					)}
					{remove.isError && (
						<Alert variant="error">
							<AlertDescription>
								We could not confirm deletion. This skill may
								already have been deleted. Refresh its current
								state before trying again.
								<Button
									type="button"
									variant="link"
									size="sm"
									loading={refreshing}
									disabled={refreshing}
									onClick={() => void refresh()}
								>
									Refresh skill
								</Button>
							</AlertDescription>
						</Alert>
					)}
					<AlertDialogFooter>
						<AlertDialogCancel
							disabled={remove.isPending || refreshing}
						>
							Cancel
						</AlertDialogCancel>
						<Button
							type="button"
							variant="destructive"
							loading={remove.isPending}
							disabled={
								!intent ||
								typed !== intent.name ||
								changed ||
								disabled ||
								!skill.capabilities.canDelete ||
								remove.isPending ||
								remove.isError ||
								refreshing
							}
							onClick={() => remove.mutate()}
						>
							Delete permanently
						</Button>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
