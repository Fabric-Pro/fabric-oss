"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { PuzzleIcon } from "@saas/shared/components/icons/PuzzleIcon";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { cn } from "@ui/lib";
import {
	ArrowRightIcon,
	MoreHorizontalIcon,
	PencilIcon,
	TrashIcon,
	TrendingUpIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

interface SkillCardProps {
	skill: {
		id: string;
		slug: string;
		name: string;
		description: string;
		category: string | null;
		tags: string[];
		scope: string;
		useCount: number;
	};
	onUpdate?: () => void;
}

const scopeConfig: Record<
	string,
	{ label: string; className: string; dot: string }
> = {
	SYSTEM: {
		label: "System",
		className: "bg-primary/10 text-primary",
		dot: "bg-primary",
	},
	ORGANIZATION: {
		label: "Organization",
		className: "bg-secondary/10 text-secondary",
		dot: "bg-secondary",
	},
	USER: {
		label: "Personal",
		className: "bg-success/10 text-success",
		dot: "bg-success",
	},
};

export function SkillCard({ skill, onUpdate }: SkillCardProps) {
	const router = useRouter();
	const queryClient = useQueryClient();
	const { basePath } = useOrganizationContext();

	const deleteMutation = useMutation({
		mutationFn: () =>
			orpcClient.skills.delete({
				id: skill.id,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["skills"] });
			onUpdate?.();
			toast.success("Skill deleted");
		},
		onError: (error) => {
			toast.error(error.message || "Failed to delete skill");
		},
	});

	const isEditable = skill.scope !== "SYSTEM";
	const scopeInfo = scopeConfig[skill.scope] ?? scopeConfig.USER;

	const handleCardClick = () => {
		router.push(`${basePath}/skills/${skill.id}`);
	};

	return (
		// biome-ignore lint/a11y/useSemanticElements: card contains nested interactive elements (Button, DropdownMenu); cannot use <button>
		<div
			className="group relative flex flex-col rounded-xl border bg-card transition-colors hover:border-primary/30 hover:bg-muted/20 cursor-pointer"
			role="button"
			tabIndex={0}
			onClick={handleCardClick}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					if (e.target !== e.currentTarget) {
						return;
					}
					e.preventDefault();
					handleCardClick();
				}
			}}
		>
			{/* Scope badge + dropdown - absolute top-right */}
			<div className="absolute top-3 right-3 z-10 flex items-center gap-1">
				{skill.useCount > 5 && (
					<span className="text-[10px] px-1.5 py-0.5 rounded font-medium leading-tight flex items-center gap-1 bg-amber-500/10 text-amber-600 border border-amber-500/20">
						<TrendingUpIcon className="h-2.5 w-2.5" />
						{skill.useCount}
					</span>
				)}
				<span
					className={cn(
						"text-[10px] px-1.5 py-0.5 rounded font-medium leading-tight flex items-center gap-1",
						scopeInfo.className,
					)}
				>
					<span
						className={cn(
							"h-1.5 w-1.5 rounded-full",
							scopeInfo.dot,
						)}
					/>
					{scopeInfo.label}
				</span>

				{isEditable && (
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button
								variant="ghost"
								size="icon-sm"
								className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
								onClick={(e) => e.stopPropagation()}
							>
								<MoreHorizontalIcon className="h-3.5 w-3.5" />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							<DropdownMenuItem
								onClick={(e) => {
									e.stopPropagation();
									router.push(
										`${basePath}/skills/${skill.id}/edit`,
									);
								}}
							>
								<PencilIcon className="h-4 w-4 mr-2" />
								Edit
							</DropdownMenuItem>
							<DropdownMenuItem
								className="text-destructive focus:text-destructive"
								onClick={(e) => {
									e.stopPropagation();
									deleteMutation.mutate();
								}}
							>
								<TrashIcon className="h-4 w-4 mr-2" />
								Delete
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				)}
			</div>

			{/* Header */}
			<div className="flex gap-3 p-4 pb-3">
				{/* Icon */}
				<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-secondary/10">
					<PuzzleIcon className="h-4.5 w-4.5 text-secondary" />
				</div>

				{/* Content - pr-16 so text clears the absolute badge */}
				<div className="flex-1 min-w-0 pr-16">
					<h3 className="font-semibold text-sm leading-snug line-clamp-2 group-hover:text-primary transition-colors">
						{skill.name}
					</h3>
					<p className="mt-1 text-xs text-muted-foreground line-clamp-2 leading-relaxed">
						{skill.description || "No description provided"}
					</p>
				</div>
			</div>

			{/* Category + tags */}
			<div className="px-4 pb-3 flex flex-wrap gap-1.5">
				{skill.category && (
					<Badge
						variant="secondary"
						className="text-[10px] px-1.5 py-0 font-normal h-4"
					>
						{skill.category}
					</Badge>
				)}
				{skill.tags.slice(0, 3).map((tag) => (
					<span
						key={tag}
						className="text-[10px] px-1.5 py-0.5 rounded-sm font-medium bg-muted text-muted-foreground"
					>
						{tag}
					</span>
				))}
				{skill.tags.length > 3 && (
					<span className="text-[10px] text-muted-foreground self-center">
						+{skill.tags.length - 3}
					</span>
				)}
			</div>

			{/* Footer */}
			<div className="mt-auto flex items-center justify-between border-t px-4 py-2.5">
				<span className="text-[11px] text-muted-foreground">
					{skill.useCount > 0
						? `Used ${skill.useCount} time${skill.useCount !== 1 ? "s" : ""}`
						: "Not used yet"}
				</span>
				{isEditable ? (
					<Button
						variant="ghost"
						size="icon-sm"
						className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
						onClick={(e) => {
							e.stopPropagation();
							router.push(`${basePath}/skills/${skill.id}/edit`);
						}}
					>
						<PencilIcon className="h-3.5 w-3.5" />
					</Button>
				) : (
					<ArrowRightIcon className="h-3.5 w-3.5 text-primary opacity-0 group-hover:opacity-100 group-hover:translate-x-0.5 transition-[opacity,transform] duration-150" />
				)}
			</div>
		</div>
	);
}
