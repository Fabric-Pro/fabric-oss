"use client";

import { config } from "@repo/config";
import { buildFabricAgentHref } from "@saas/agents/lib/fabric-agent-links";
import { useSession } from "@saas/auth/hooks/use-session";
import { IncidentChip } from "@saas/shared/components/IncidentChip";
import { SparklesIcon } from "@saas/shared/components/icons/SparklesIcon";
import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { ChevronDownIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import {
	DASHBOARD_GREETING_COUNT,
	getDashboardGreeting,
} from "../lib/greetings";

interface DashboardHeroProps {
	organizationName: string;
	organizationSlug: string;
	isOrganizationAdmin: boolean;
	onRefresh: () => void;
	refreshing: boolean;
}

export function DashboardHero({
	organizationName,
	organizationSlug,
	isOrganizationAdmin,
	onRefresh,
	refreshing,
}: DashboardHeroProps) {
	const { user } = useSession();
	const [greetingIndex, setGreetingIndex] = useState(0);
	const [today, setToday] = useState("");
	useEffect(() => {
		setGreetingIndex(Math.floor(Math.random() * DASHBOARD_GREETING_COUNT));
	}, []);
	useEffect(() => {
		setToday(
			new Date().toLocaleDateString(undefined, {
				weekday: "long",
				day: "numeric",
				month: "long",
			}),
		);
	}, []);
	const basePath = `/app/${organizationSlug}`;
	const askGenieHref = buildFabricAgentHref({
		basePath,
		prompt: "Help me decide what to work on next.",
	});

	return (
		<div className="flex flex-wrap items-start justify-between gap-4">
			<div>
				<h1
					id="organization-dashboard-title"
					tabIndex={-1}
					className="text-xl font-semibold tracking-[-0.025em] text-foreground"
				>
					{getDashboardGreeting(user?.name, greetingIndex)}
				</h1>
				<p className="fab-label mt-2">
					{today
						? `${organizationName} · ${today}`
						: organizationName}
				</p>
			</div>
			<div className="flex shrink-0 flex-wrap items-center gap-2">
				<IncidentChip />
				<Button asChild variant="outline" size="sm">
					<Link href={askGenieHref}>
						<SparklesIcon className="size-3.5" />
						Ask Genie
					</Link>
				</Button>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button size="sm" className="gap-1.5">
							<PlusIcon className="size-3.5" aria-hidden />
							New
							<ChevronDownIcon
								className="size-3 text-primary-foreground"
								aria-hidden
							/>
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="w-48">
						<DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
							Create or start
						</DropdownMenuLabel>
						<DropdownMenuSeparator />
						<DropdownMenuItem asChild>
							<Link href={`${basePath}/projects/new`}>
								New project
							</Link>
						</DropdownMenuItem>
						<DropdownMenuItem asChild>
							<Link href={`${basePath}/agents/fabric-ai`}>
								Start chat
							</Link>
						</DropdownMenuItem>
						{isOrganizationAdmin ? (
							<>
								<DropdownMenuSeparator />
								<DropdownMenuItem asChild>
									<Link
										href={`${basePath}/agents?agentView=new`}
									>
										New agent
									</Link>
								</DropdownMenuItem>
								<DropdownMenuItem asChild>
									<Link href={`${basePath}/workflows/new`}>
										New workflow
									</Link>
								</DropdownMenuItem>
								{config.prompts.enabled ? (
									<DropdownMenuItem asChild>
										<Link href={`${basePath}/prompts/new`}>
											New prompt
										</Link>
									</DropdownMenuItem>
								) : null}
								<DropdownMenuItem asChild>
									<Link href={`${basePath}/skills/new`}>
										New skill
									</Link>
								</DropdownMenuItem>
								<DropdownMenuItem asChild>
									<Link href={`${basePath}/mcp-servers`}>
										Connect MCP
									</Link>
								</DropdownMenuItem>
							</>
						) : null}
					</DropdownMenuContent>
				</DropdownMenu>
				<Button
					variant="ghost"
					size="icon-sm"
					onClick={onRefresh}
					disabled={refreshing}
					aria-label="Refresh dashboard"
					title="Refresh dashboard"
				>
					<RefreshCwIcon
						className={
							refreshing ? "size-4 animate-spin" : "size-4"
						}
						aria-hidden
					/>
				</Button>
			</div>
		</div>
	);
}
