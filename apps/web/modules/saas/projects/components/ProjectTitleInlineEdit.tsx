"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Input } from "@ui/components/input";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { Loader2Icon, PencilIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

type Props = {
	projectId: string;
	organizationId: string | null | undefined;
	name: string;
	canEdit: boolean;
	renderDisplay: (name: string) => React.ReactNode;
	inputClassName?: string;
};

export function ProjectTitleInlineEdit({
	projectId,
	organizationId,
	name,
	canEdit,
	renderDisplay,
	inputClassName,
}: Props) {
	const tTooltips = useTranslations("tooltips.common");
	const [isEditing, setIsEditing] = useState(false);
	const [value, setValue] = useState(name);
	const inputRef = useRef<HTMLInputElement>(null);
	const queryClient = useQueryClient();

	// Sync value when name prop changes (e.g. after successful mutation)
	useEffect(() => {
		if (!isEditing) {
			setValue(name);
		}
	}, [name, isEditing]);

	// Focus and select input when entering edit mode
	useEffect(() => {
		if (isEditing && inputRef.current) {
			inputRef.current.focus();
			inputRef.current.select();
		}
	}, [isEditing]);

	const { mutate, isPending } = useMutation(
		orpc.projects.update.mutationOptions({
			onSuccess: () => {
				queryClient.invalidateQueries({
					queryKey: orpc.projects.get.queryKey({
						input: { id: projectId, organizationId },
					}),
				});
				queryClient.invalidateQueries({ queryKey: ["projects"] });
				setIsEditing(false);
			},
			onError: (error) => {
				toast.error("Failed to rename project", {
					description:
						error instanceof Error ? error.message : String(error),
				});
				setValue(name);
				setIsEditing(false);
			},
		}),
	);

	function handleSave() {
		const trimmed = value.trim();
		if (!trimmed) {
			toast.error("Project name cannot be empty");
			setValue(name);
			setIsEditing(false);
			return;
		}
		if (trimmed.length > 255) {
			toast.error("Project name is too long (max 255 characters)");
			return;
		}
		if (trimmed === name) {
			setIsEditing(false);
			return;
		}
		mutate({
			id: projectId,
			organizationId: organizationId ?? null,
			name: trimmed,
		});
	}

	function handleCancel() {
		setValue(name);
		setIsEditing(false);
	}

	if (!canEdit) {
		return <>{renderDisplay(name)}</>;
	}

	if (isEditing) {
		return (
			<div className="flex items-center gap-2">
				<Input
					ref={inputRef}
					value={value}
					onChange={(e) => setValue(e.target.value.slice(0, 255))}
					onBlur={handleCancel}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							handleSave();
						} else if (e.key === "Escape") {
							handleCancel();
						}
					}}
					maxLength={255}
					disabled={isPending}
					className={inputClassName}
				/>
				{isPending && (
					<Loader2Icon className="size-4 animate-spin shrink-0" />
				)}
			</div>
		);
	}

	return (
		<span className="group flex items-center gap-2 text-left">
			{renderDisplay(name)}
			<Tooltip>
				<TooltipTrigger asChild>
					<button
						type="button"
						onClick={() => setIsEditing(true)}
						className="shrink-0 rounded p-0.5 opacity-0 group-hover:opacity-60 hover:opacity-100 transition-opacity cursor-pointer"
						aria-label="Rename project"
					>
						<PencilIcon className="size-4" />
					</button>
				</TooltipTrigger>
				<TooltipContent>
					{tTooltips("clickToRename", { subject: "project" })}
				</TooltipContent>
			</Tooltip>
		</span>
	);
}
