"use client";

import { RobotIcon } from "@saas/shared/components/icons/RobotIcon";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { cn } from "@ui/lib";
import { formatDistanceToNow } from "date-fns";
import {
	ArrowRightIcon,
	BarChart3Icon,
	BriefcaseIcon,
	CodeIcon,
	EditIcon,
	HeadphonesIcon,
	MegaphoneIcon,
	MoreVerticalIcon,
	RocketIcon,
	ScaleIcon,
	SettingsIcon,
	SparklesIcon,
	TrashIcon,
	WalletIcon,
	ZapIcon,
} from "lucide-react";
import Link from "next/link";

type AgentTemplate = {
	id: string;
	slug: string;
	name: string;
	displayName: string;
	description: string;
	heroEmojis: string[];
	heroImageUrl?: string | null;
	category: string;
	tags: string[];
	scope: string;
	instructions: string;
	suggestedModel?: string | null;
	isFeatured: boolean;
	useCount: number;
	lastUsedAt: string | null;
	createdAt: string;
};

type Props = {
	template: AgentTemplate;
	onCreateInstance?: (template: AgentTemplate) => void;
	onDelete?: (id: string) => void;
	basePath?: string;
	onClick?: () => void;
};

const categoryColors: Record<string, string> = {
	DATA: "from-blue-500 to-blue-600",
	DESIGN: "from-purple-500 to-purple-600",
	ENGINEERING: "from-green-500 to-green-600",
	FINANCE: "from-emerald-500 to-emerald-600",
	HIRING: "from-amber-500 to-amber-600",
	KNOWLEDGE: "from-indigo-500 to-indigo-600",
	LEGAL: "from-slate-500 to-slate-600",
	MARKETING: "from-pink-500 to-pink-600",
	OPERATIONS: "from-orange-500 to-orange-600",
	PRODUCT: "from-cyan-500 to-cyan-600",
	PRODUCT_MANAGEMENT: "from-cyan-500 to-cyan-600",
	PRODUCTIVITY: "from-rose-500 to-rose-600",
	SALES: "from-amber-500 to-yellow-500",
	SUPPORT: "from-teal-500 to-teal-600",
	GENERAL: "from-gray-500 to-gray-600",
};

const categoryIcons: Record<string, React.ElementType> = {
	DATA: BarChart3Icon,
	DESIGN: SparklesIcon,
	ENGINEERING: CodeIcon,
	FINANCE: WalletIcon,
	HIRING: BriefcaseIcon,
	KNOWLEDGE: RobotIcon,
	LEGAL: ScaleIcon,
	MARKETING: MegaphoneIcon,
	OPERATIONS: SettingsIcon,
	PRODUCT: RocketIcon,
	PRODUCT_MANAGEMENT: RocketIcon,
	PRODUCTIVITY: ZapIcon,
	SALES: BriefcaseIcon,
	SUPPORT: HeadphonesIcon,
	GENERAL: RobotIcon,
};

const categoryDotColors: Record<string, string> = {
	DATA: "bg-blue-500",
	DESIGN: "bg-purple-500",
	ENGINEERING: "bg-green-500",
	FINANCE: "bg-emerald-500",
	HIRING: "bg-amber-500",
	KNOWLEDGE: "bg-indigo-500",
	LEGAL: "bg-slate-500",
	MARKETING: "bg-pink-500",
	OPERATIONS: "bg-orange-500",
	PRODUCT: "bg-cyan-500",
	PRODUCT_MANAGEMENT: "bg-cyan-500",
	PRODUCTIVITY: "bg-rose-500",
	SALES: "bg-amber-500",
	SUPPORT: "bg-teal-500",
	GENERAL: "bg-gray-500",
};

const categoryLabels: Record<string, string> = {
	DATA: "Data",
	DESIGN: "Design",
	ENGINEERING: "Engineering",
	FINANCE: "Finance",
	HIRING: "Hiring",
	KNOWLEDGE: "Knowledge",
	LEGAL: "Legal",
	MARKETING: "Marketing",
	OPERATIONS: "Operations",
	PRODUCT: "Product",
	PRODUCT_MANAGEMENT: "Product Mgmt",
	PRODUCTIVITY: "Productivity",
	SALES: "Sales",
	SUPPORT: "Support",
	GENERAL: "General",
};

export function AgentTemplateCard({
	template,
	onCreateInstance: _onCreateInstance,
	onDelete,
	basePath = "/app/agent-templates",
	onClick,
}: Props) {
	const CategoryIcon = categoryIcons[template.category] || RobotIcon;
	const categoryGradient =
		categoryColors[template.category] || categoryColors.GENERAL;
	const isClickable = Boolean(onClick);

	return (
		<Card
			className={cn(
				"group relative flex h-full cursor-pointer flex-col rounded-2xl border bg-card p-5 transition-all duration-300 hover:border-primary/50 hover:shadow-lg",
			)}
			onClick={onClick}
			onKeyDown={(e) => {
				if (onClick && (e.key === "Enter" || e.key === " ")) {
					e.preventDefault();
					onClick();
				}
			}}
			role={isClickable ? "button" : undefined}
			tabIndex={isClickable ? 0 : undefined}
			aria-disabled={isClickable ? undefined : true}
		>
			{template.isFeatured && (
				<div className="absolute -right-2 -top-2 z-10">
					<Badge className="border-0 bg-gradient-to-r from-amber-500 to-orange-500 text-white shadow-lg">
						<SparklesIcon className="mr-1 h-3 w-3" />
						Featured
					</Badge>
				</div>
			)}

			<div className="flex items-start gap-4">
				<div
					className={cn(
						"flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br shadow-lg",
						categoryGradient,
					)}
				>
					<CategoryIcon className="h-7 w-7 text-white" />
				</div>

				<div className="min-w-0 flex-1">
					<div className="flex items-start justify-between gap-2">
						<Link
							href={`${basePath}/${template.slug}`}
							className="line-clamp-1 text-lg font-semibold transition-colors hover:text-primary"
							onClick={(e) => e.stopPropagation()}
						>
							{template.displayName}
						</Link>
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button
									variant="ghost"
									size="icon"
									className="-mr-1 -mt-1 h-7 w-7 opacity-0 group-hover:opacity-100"
									onClick={(e) => e.stopPropagation()}
								>
									<MoreVerticalIcon className="h-4 w-4" />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuItem asChild>
									<Link href={`${basePath}/${template.slug}`}>
										<EditIcon className="mr-2 h-4 w-4" />
										View Details
									</Link>
								</DropdownMenuItem>
								{template.scope !== "SYSTEM" && onDelete && (
									<>
										<DropdownMenuSeparator />
										<DropdownMenuItem
											onClick={() =>
												onDelete(template.id)
											}
											className="text-destructive"
										>
											<TrashIcon className="mr-2 h-4 w-4" />
											Delete
										</DropdownMenuItem>
									</>
								)}
							</DropdownMenuContent>
						</DropdownMenu>
					</div>

					<div className="mt-1.5 flex items-center gap-2">
						<div
							className={cn(
								"h-2 w-2 rounded-full",
								categoryDotColors[template.category] ||
									categoryDotColors.GENERAL,
							)}
						/>
						<span className="text-xs font-medium text-muted-foreground">
							{categoryLabels[template.category] ||
								template.category}
						</span>
					</div>
				</div>
			</div>

			<p className="mt-4 line-clamp-2 flex-1 text-sm text-muted-foreground">
				{template.description}
			</p>

			<div className="mt-4 rounded-xl border bg-muted/30 p-3">
				<p className="line-clamp-4 whitespace-pre-wrap text-xs text-muted-foreground">
					{template.instructions}
				</p>
			</div>

			{template.tags.length > 0 && (
				<div className="mt-3 flex flex-wrap gap-1">
					{template.tags.slice(0, 3).map((tag) => (
						<Badge
							key={tag}
							variant="outline"
							className="px-2 py-0 text-xs font-normal"
						>
							{tag}
						</Badge>
					))}
					{template.tags.length > 3 && (
						<span className="text-xs text-muted-foreground">
							+{template.tags.length - 3}
						</span>
					)}
				</div>
			)}

			<div className="mt-5 flex items-center justify-between border-t pt-4">
				<span className="text-xs text-muted-foreground">
					{template.useCount > 0
						? `${template.useCount} uses`
						: template.lastUsedAt
							? `Last ${formatDistanceToNow(new Date(template.lastUsedAt), { addSuffix: true })}`
							: "New"}
				</span>
				<Button
					size="sm"
					variant="outline"
					className="gap-1.5"
					onClick={(e: React.MouseEvent) => {
						e.stopPropagation();
						onClick?.();
					}}
				>
					View Template
					<ArrowRightIcon className="h-3.5 w-3.5" />
				</Button>
			</div>
		</Card>
	);
}
