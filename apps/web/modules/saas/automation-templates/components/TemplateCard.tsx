"use client";

import { useBasePath } from "@saas/organizations/hooks/use-organization-context";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { formatDistanceToNow } from "date-fns";
import {
	ArrowRightIcon,
	ClockIcon,
	GlobeIcon,
	LockIcon,
	MoreVerticalIcon,
	PencilIcon,
	PlayIcon,
	TrashIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";

type AutomationTemplate = {
	id: string;
	name: string;
	description: string | null;
	category: string | null;
	tags: string[];
	isPublic: boolean;
	useCount: number;
	lastUsedAt: Date | string | null;
	createdAt: Date | string;
	updatedAt: Date | string;
	version: number;
};

type Props = {
	template: AutomationTemplate;
	onExecute: (template: AutomationTemplate) => void;
	onDelete: (template: AutomationTemplate) => void;
};

export function TemplateCard({ template, onExecute, onDelete }: Props) {
	const router = useRouter();
	// Personal context resolves to `/app`, an organization to `/app/{slug}` —
	// so a card opened inside an organization stays inside it (Fizzy #1875 R11).
	const basePath = useBasePath();

	const shortDescription = template.description
		? template.description.length > 100
			? `${template.description.slice(0, 100)}...`
			: template.description
		: "No description provided";

	const lastUsed = template.lastUsedAt
		? formatDistanceToNow(new Date(template.lastUsedAt), {
				addSuffix: true,
			})
		: "Never used";

	return (
		<div className="group flex flex-col overflow-hidden rounded-xl border bg-card/50 transition-all hover:border-primary/30 hover:shadow-lg">
			{/* Header */}
			<div className="flex items-start justify-between p-4 pb-2">
				<div className="flex items-center gap-2">
					{template.isPublic ? (
						<GlobeIcon className="h-4 w-4 text-muted-foreground" />
					) : (
						<LockIcon className="h-4 w-4 text-muted-foreground" />
					)}
					<span className="text-xs text-muted-foreground">
						v{template.version}
					</span>
				</div>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button variant="ghost" size="icon-sm">
							<MoreVerticalIcon className="h-4 w-4" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuItem
							onClick={() =>
								router.push(
									`${basePath}/automation-templates/${template.id}`,
								)
							}
						>
							<PencilIcon className="h-4 w-4 mr-2" />
							Edit
						</DropdownMenuItem>
						<DropdownMenuItem onClick={() => onExecute(template)}>
							<PlayIcon className="h-4 w-4 mr-2" />
							Execute
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							className="text-destructive"
							onClick={() => onDelete(template)}
						>
							<TrashIcon className="h-4 w-4 mr-2" />
							Delete
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>

			{/* Content */}
			<div className="flex flex-1 flex-col px-4 pb-4">
				<h3 className="mb-2 font-semibold text-lg line-clamp-1">
					{template.name}
				</h3>
				<p className="mb-3 line-clamp-2 text-muted-foreground text-sm">
					{shortDescription}
				</p>

				{/* Category & Tags */}
				<div className="flex flex-wrap gap-1 mb-3">
					{template.category && (
						<Badge variant="secondary" className="text-xs">
							{template.category}
						</Badge>
					)}
					{template.tags.slice(0, 2).map((tag) => (
						<Badge key={tag} variant="outline" className="text-xs">
							{tag}
						</Badge>
					))}
					{template.tags.length > 2 && (
						<Badge variant="outline" className="text-xs">
							+{template.tags.length - 2}
						</Badge>
					)}
				</div>

				{/* Stats */}
				<div className="flex items-center gap-4 text-xs text-muted-foreground mb-4">
					<span className="flex items-center gap-1">
						<PlayIcon className="h-3 w-3" />
						{template.useCount} runs
					</span>
					<span className="flex items-center gap-1">
						<ClockIcon className="h-3 w-3" />
						{lastUsed}
					</span>
				</div>

				{/* Actions */}
				<div className="mt-auto flex gap-2">
					<Button
						variant="outline"
						size="sm"
						className="flex-1"
						onClick={() =>
							router.push(
								`${basePath}/automation-templates/${template.id}`,
							)
						}
					>
						View
						<ArrowRightIcon className="h-3 w-3 ml-1" />
					</Button>
					<Button
						size="sm"
						className="flex-1"
						onClick={() => onExecute(template)}
					>
						<PlayIcon className="h-3 w-3 mr-1" />
						Run
					</Button>
				</div>
			</div>
		</div>
	);
}
