"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { cn } from "@ui/lib";
import { DatabaseZap, RadioTower, Wrench } from "lucide-react";

interface RetrievalStrategyCalloutProps {
	variant?: "default" | "compact";
	className?: string;
}

const STRATEGIES = [
	{
		icon: DatabaseZap,
		title: "Indexed knowledge first",
		description:
			"For search and retrieval, Fabric should usually prefer synced company data because it is faster, already processed, and easier to cite.",
	},
	{
		icon: RadioTower,
		title: "Live systems when freshness matters",
		description:
			"Use integrations or MCP tools when you need real-time state, private records that are not indexed yet, or write access.",
	},
	{
		icon: Wrench,
		title: "Best fit by task type",
		description:
			"Searchable integrations are best for retrieval-heavy assistants. MCP servers remain the action layer for tools, automations, and operational workflows.",
	},
] as const;

export function RetrievalStrategyCallout({
	variant = "default",
	className,
}: RetrievalStrategyCalloutProps) {
	if (variant === "compact") {
		return (
			<div
				className={cn(
					"rounded-xl border border-border/60 bg-muted/20 p-3",
					className,
				)}
			>
				<h3 className="text-sm font-semibold text-foreground">
					How Fabric Chooses Context
				</h3>
				<div className="mt-3 space-y-2.5">
					{STRATEGIES.map(({ icon: Icon, title, description }) => (
						<div
							key={title}
							className="rounded-lg border border-border/50 bg-background/80 p-2.5"
						>
							<div className="mb-1.5 flex items-center gap-2 text-sm font-medium text-foreground">
								<Icon className="h-4 w-4 text-primary" />
								<span>{title}</span>
							</div>
							<p className="text-xs leading-5 text-muted-foreground">
								{description}
							</p>
						</div>
					))}
				</div>
			</div>
		);
	}

	return (
		<Card
			className={cn(
				"border-primary/20 bg-gradient-to-br from-primary/5 via-background to-emerald-500/5",
				className,
			)}
		>
			<CardHeader className="pb-3">
				<CardTitle className="text-base">
					How Fabric Chooses Context
				</CardTitle>
			</CardHeader>
			<CardContent className="grid gap-3 md:grid-cols-3">
				{STRATEGIES.map(({ icon: Icon, title, description }) => (
					<div
						key={title}
						className="rounded-lg border bg-background/80 p-3"
					>
						<div className="mb-2 flex items-center gap-2 font-medium">
							<Icon className="h-4 w-4 text-primary" />
							{title}
						</div>
						<p className="text-sm text-muted-foreground">
							{description}
						</p>
					</div>
				))}
			</CardContent>
		</Card>
	);
}
