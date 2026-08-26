"use client";

import { RobotIcon } from "@saas/shared/components/icons/RobotIcon";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@ui/components/sheet";
import {
	BarChart3Icon,
	BookOpenIcon,
	BriefcaseIcon,
	CodeIcon,
	HeadphonesIcon,
	RocketIcon,
	ScaleIcon,
	SearchIcon,
	SettingsIcon,
	SparklesIcon,
	WalletIcon,
	XIcon,
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
	open: boolean;
	onOpenChange: (open: boolean) => void;
	template: AgentTemplate | null;
	basePath?: string;
};

const categoryIcons: Record<string, React.ElementType> = {
	DATA: BarChart3Icon,
	DESIGN: SparklesIcon,
	ENGINEERING: CodeIcon,
	FINANCE: WalletIcon,
	HIRING: BriefcaseIcon,
	KNOWLEDGE: BookOpenIcon,
	LEGAL: ScaleIcon,
	MARKETING: SparklesIcon,
	OPERATIONS: SettingsIcon,
	PRODUCT: RocketIcon,
	PRODUCT_MANAGEMENT: RocketIcon,
	PRODUCTIVITY: ZapIcon,
	SALES: BriefcaseIcon,
	SUPPORT: HeadphonesIcon,
	GENERAL: RobotIcon,
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
	PRODUCT_MANAGEMENT: "Product Management",
	PRODUCTIVITY: "Productivity",
	SALES: "Sales",
	SUPPORT: "Support",
	GENERAL: "General",
};

export function TemplatePreviewSheet({
	open,
	onOpenChange,
	template,
	basePath = "/app/agent-templates",
}: Props) {
	if (!template) {
		return null;
	}

	const CategoryIcon = categoryIcons[template.category] || RobotIcon;
	const categoryLabel =
		categoryLabels[template.category] || template.category;

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				hideCloseButton
				className="overflow-y-auto border-l bg-background p-0"
				style={{
					width: "min(1120px, 100vw)",
					maxWidth: "min(1120px, 100vw)",
				}}
			>
				<div className="flex items-center justify-between border-b px-5 py-4">
					<div className="min-w-0">
						<SheetTitle className="truncate text-xl font-semibold text-foreground">
							Template {template.displayName}
						</SheetTitle>
					</div>
					<Button
						variant="ghost"
						size="icon"
						className="h-8 w-8 shrink-0"
						onClick={() => onOpenChange(false)}
					>
						<XIcon className="h-4 w-4" />
					</Button>
				</div>

				<div className="space-y-6 px-5 py-5">
					<SheetHeader className="space-y-4 text-left">
						<div className="flex items-start gap-4">
							<div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl border bg-muted/40">
								<CategoryIcon className="h-8 w-8 text-muted-foreground" />
							</div>
							<div className="min-w-0 flex-1">
								<div className="mb-2 flex flex-wrap items-center gap-2">
									<Badge variant="secondary">
										{categoryLabel}
									</Badge>
									{template.isFeatured && (
										<Badge variant="outline">
											Featured
										</Badge>
									)}
								</div>
								<p className="text-2xl font-semibold tracking-tight text-foreground">
									@{template.name}
								</p>
								<div className="mt-3">
									<Button
										asChild
										className="h-10 rounded-xl px-4"
									>
										<Link
											href={`${basePath}/${template.slug}`}
											onClick={() => onOpenChange(false)}
										>
											Use this template
										</Link>
									</Button>
								</div>
							</div>
						</div>
						<SheetDescription className="text-base leading-7 text-foreground">
							{template.description}
						</SheetDescription>
					</SheetHeader>

					<div className="space-y-4">
						<div>
							<h4 className="mb-2 text-sm font-semibold text-foreground">
								Instructions
							</h4>
							<div className="max-h-[360px] overflow-y-auto rounded-2xl border bg-muted/25 p-4">
								<p className="whitespace-pre-wrap text-sm leading-7 text-muted-foreground">
									{template.instructions ||
										template.description}
								</p>
							</div>
						</div>

						{template.tags.length > 0 && (
							<div>
								<h4 className="mb-2 text-sm font-semibold text-foreground">
									Tags
								</h4>
								<div className="flex flex-wrap gap-2">
									{template.tags.map((tag) => (
										<Badge key={tag} variant="outline">
											{tag}
										</Badge>
									))}
								</div>
							</div>
						)}

						<div className="rounded-2xl border bg-muted/20 p-4">
							<h4 className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
								<SearchIcon className="h-4 w-4 text-muted-foreground" />
								What happens next
							</h4>
							<p className="text-sm leading-6 text-muted-foreground">
								You will land on the agent setup page with these
								instructions pre-filled. From there you can add
								knowledge, tools, triggers, and your own agent
								name before creating it.
							</p>
						</div>
					</div>
				</div>
			</SheetContent>
		</Sheet>
	);
}
