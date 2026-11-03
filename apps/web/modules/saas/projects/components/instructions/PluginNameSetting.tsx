"use client";

/**
 * The Coding Instructions plugin's name in coding tools: skills read
 * `/<name>:<skill>` (specs/2026-10-21-ai-artifacts-hub). The default is the
 * project's name as a slug; a person who may change the instructions can set
 * another. Coding tools take it on their next set-up, and an existing install
 * with `fabric instructions init --rename`.
 */

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Loader2Icon, PencilIcon } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";

export function PluginNameSetting({
	projectId,
	canEdit,
}: {
	projectId: string;
	canEdit?: boolean;
}) {
	const id = useId();
	const queryClient = useQueryClient();
	const current = useQuery(
		orpc.projects.instructions.getPluginName.queryOptions({
			input: { projectId },
		}),
	);
	const save = useMutation(
		orpc.projects.instructions.setPluginName.mutationOptions(),
	);
	const [editing, setEditing] = useState(false);
	const [value, setValue] = useState("");
	const [problem, setProblem] = useState<string | null>(null);

	if (!current.data) {
		return null;
	}
	const { name, custom, defaultName } = current.data;

	async function submit(next: string | null) {
		setProblem(null);
		try {
			await save.mutateAsync({ projectId, name: next });
			await queryClient.invalidateQueries({
				queryKey: orpc.projects.instructions.getPluginName.key(),
			});
			setEditing(false);
			toast.success(
				"Plugin name saved. Coding tools pick it up on their next set-up; an existing one with fabric instructions init --rename.",
			);
		} catch (error) {
			setProblem(
				error instanceof Error
					? error.message
					: "The name was not saved.",
			);
		}
	}

	return (
		<div className="flex flex-wrap items-center gap-2 text-sm">
			<span className="text-muted-foreground">
				Plugin name in coding tools:
			</span>
			{editing ? (
				<form
					className="flex flex-wrap items-center gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						void submit(value);
					}}
				>
					<label htmlFor={`${id}-name`} className="sr-only">
						Plugin name
					</label>
					<Input
						id={`${id}-name`}
						className="h-8 w-48"
						value={value}
						placeholder={defaultName}
						disabled={save.isPending}
						onChange={(e) => setValue(e.target.value)}
						aria-describedby={problem ? `${id}-problem` : undefined}
					/>
					<Button type="submit" size="sm" disabled={save.isPending}>
						{save.isPending ? (
							<Loader2Icon
								className="size-4 motion-safe:animate-spin"
								aria-hidden="true"
							/>
						) : null}
						Save
					</Button>
					{custom ? (
						<Button
							type="button"
							size="sm"
							variant="ghost"
							disabled={save.isPending}
							onClick={() => void submit(null)}
						>
							Use {defaultName}
						</Button>
					) : null}
					<Button
						type="button"
						size="sm"
						variant="ghost"
						disabled={save.isPending}
						onClick={() => {
							setEditing(false);
							setProblem(null);
						}}
					>
						Cancel
					</Button>
				</form>
			) : (
				<>
					<code className="rounded bg-muted px-1.5 py-0.5 text-xs">
						/{name}:&lt;skill&gt;
					</code>
					{canEdit ? (
						<Button
							type="button"
							size="sm"
							variant="ghost"
							aria-label="Change the plugin name"
							onClick={() => {
								setValue(name);
								setEditing(true);
							}}
						>
							<PencilIcon
								className="size-3.5"
								aria-hidden="true"
							/>
						</Button>
					) : null}
				</>
			)}
			{problem ? (
				<p
					id={`${id}-problem`}
					role="alert"
					className="w-full text-destructive text-xs"
				>
					{problem}
				</p>
			) : null}
		</div>
	);
}
