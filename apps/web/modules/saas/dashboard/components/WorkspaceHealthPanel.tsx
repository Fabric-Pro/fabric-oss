"use client";

import { resolveNotificationLink } from "@saas/notifications/lib/resolve-notification-link";
import { Badge } from "@ui/components/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { ArrowRightIcon, CircleAlertIcon } from "lucide-react";
import Link from "next/link";
import type { HomeNotification } from "../lib/home-model";

interface WorkspaceHealthPanelProps {
	items: HomeNotification[];
	basePath: string;
	isOrganizationAdmin: boolean;
}

export function WorkspaceHealthPanel({
	items,
	basePath,
	isOrganizationAdmin,
}: WorkspaceHealthPanelProps) {
	if (items.length === 0) {
		return null;
	}
	return (
		<Card className="border-highlight/40">
			<CardHeader className="flex flex-row items-center gap-2 px-5 pb-3 pt-4">
				<CircleAlertIcon
					className="size-4 text-highlight-ink"
					aria-hidden
				/>
				<CardTitle className="text-base">
					{isOrganizationAdmin
						? "Workspace health"
						: "Setup needs attention"}
				</CardTitle>
				<Badge variant="warning">{items.length}</Badge>
			</CardHeader>
			<CardContent className="p-0">
				<div className="divide-y divide-border">
					{items.map((item) => {
						const href = resolveNotificationLink(item.link, {
							notificationBasePath: item.organizationSlug
								? `/app/${item.organizationSlug}`
								: "/app",
							currentBasePath: basePath,
						});
						const content = (
							<>
								<span className="min-w-0 flex-1">
									<span className="block truncate text-sm font-medium">
										{item.title}
									</span>
									{item.snippet ? (
										<span className="mt-0.5 block truncate text-xs text-muted-foreground">
											{item.snippet}
										</span>
									) : null}
								</span>
								<ArrowRightIcon
									className="size-4 shrink-0 text-highlight-ink"
									aria-hidden
								/>
							</>
						);
						return href ? (
							<Link
								key={item.id}
								href={href}
								className="flex items-center gap-4 px-5 py-3 transition-colors duration-150 hover:bg-muted/50 focus-visible:outline-hidden focus-visible:bg-muted/50"
							>
								{content}
							</Link>
						) : (
							<div
								key={item.id}
								className="flex items-center gap-4 px-5 py-3"
							>
								{content}
							</div>
						);
					})}
				</div>
			</CardContent>
		</Card>
	);
}
