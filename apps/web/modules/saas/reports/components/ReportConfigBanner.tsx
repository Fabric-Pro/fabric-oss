"use client";

import type { ReportReadiness } from "@saas/reports/lib/report-readiness";
import { Button } from "@ui/components/button";
import { cn } from "@ui/lib";
import {
	AlertCircleIcon,
	CloudOffIcon,
	KeyRoundIcon,
	type LucideIcon,
	PlugIcon,
	TriangleAlertIcon,
	XIcon,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

type Tone = "warning" | "destructive";

interface BannerAction {
	label: string;
	onClick?: () => void;
	href?: string;
	primary?: boolean;
}

interface BannerItem {
	id: string;
	tone: Tone;
	icon: LucideIcon;
	title: string;
	message: string;
	actions: BannerAction[];
}

const TONE_CONTAINER: Record<Tone, string> = {
	warning: "border-highlight/40 bg-highlight/5",
	destructive: "border-destructive/30 bg-destructive/5",
};
const TONE_BAR: Record<Tone, string> = {
	warning: "bg-highlight",
	destructive: "bg-destructive",
};
const TONE_ICON: Record<Tone, string> = {
	warning: "bg-highlight/10 text-highlight",
	destructive: "bg-destructive/10 text-destructive",
};

// Step 2 of the two-step connection-recovery flow. After reconnecting an MCP
// data source (step 1), the project/resource must be re-selected — this step is
// easy to miss, so the connection banners spell it out explicitly.
const STEP2_PHRASE =
	"re-select your project in the Data Source Connection section below";

function buildItems(
	readiness: ReportReadiness,
	handlers: {
		onTest: () => void;
		onScrollToConnection: () => void;
		onScrollToParams: () => void;
		reconnectHref?: string;
	},
): BannerItem[] {
	const items: BannerItem[] = [];
	const { connection, missingRequiredParams } = readiness;

	const reselectAction: BannerAction = {
		label: "Re-select project",
		onClick: handlers.onScrollToConnection,
	};

	if (connection === "not_configured") {
		items.push({
			id: "conn",
			tone: "warning",
			icon: PlugIcon,
			title: "Connect your data source — it takes two steps",
			message: `This report can’t run until its data source is set up. Step 1 — connect or reconnect the data source. Step 2 — ${STEP2_PHRASE}. Then you’re ready to generate.`,
			actions: [
				{
					label: "Configure connection",
					onClick: handlers.onScrollToConnection,
					primary: true,
				},
			],
		});
	} else if (connection === "connection_unavailable") {
		items.push({
			id: "conn",
			tone: "destructive",
			icon: TriangleAlertIcon,
			title: "This report’s data source connection is no longer available",
			message: `The connection saved for this report can’t be found anymore — it may have been removed, reconnected (which creates a new connection), or set up by someone else. Step 1 — pick a connection in the Data Source Connection section below. Step 2 — ${STEP2_PHRASE}. Until then, generating and saving will fail.`,
			actions: [
				{
					label: "Fix connection",
					onClick: handlers.onScrollToConnection,
					primary: true,
				},
			],
		});
	} else if (connection === "auth_expired") {
		items.push({
			id: "conn",
			tone: "warning",
			icon: KeyRoundIcon,
			title: "Reconnect to continue — then re-select your project",
			message: `Recovering this connection takes two steps. Step 1 — reconnect the integration (its access token is no longer valid). Step 2 — ${STEP2_PHRASE}. Reports often fail silently after step 1 alone, so don’t skip step 2.`,
			actions: [
				handlers.reconnectHref
					? {
							label: "Reconnect",
							href: handlers.reconnectHref,
							primary: true,
						}
					: {
							label: "Retry test",
							onClick: handlers.onTest,
							primary: true,
						},
				reselectAction,
			],
		});
	} else if (connection === "unreachable") {
		items.push({
			id: "conn",
			tone: "destructive",
			icon: CloudOffIcon,
			title: "Data source didn’t respond",
			message: `The connection test timed out — the service may be temporarily unreachable, so try again shortly. If you end up reconnecting it, you’ll also need to ${STEP2_PHRASE}.`,
			actions: [
				{
					label: "Retry test",
					onClick: handlers.onTest,
					primary: true,
				},
			],
		});
	} else if (connection === "error") {
		items.push({
			id: "conn",
			tone: "destructive",
			icon: AlertCircleIcon,
			title: "Connection test failed",
			message: `Fabric reached the data source but the test returned an error. Check the connection values below, then run the test again. If you reconnect it, you’ll also need to ${STEP2_PHRASE}.`,
			actions: [
				{
					label: "Retry test",
					onClick: handlers.onTest,
					primary: true,
				},
				{
					label: "View details",
					onClick: handlers.onScrollToConnection,
				},
			],
		});
	} else if (connection === "project_not_selected") {
		// Step 1 (reconnect) is already done — surface ONLY the remaining step.
		items.push({
			id: "conn",
			tone: "warning",
			icon: PlugIcon,
			title: "One step left: re-select your project",
			message: `Your data source is connected, but no project is selected for it yet — so generation will fail. Just ${STEP2_PHRASE}, then generate. (Step 1, reconnecting, is already done.)`,
			actions: [
				{
					...reselectAction,
					primary: true,
				},
			],
		});
	}

	if (missingRequiredParams.length > 0) {
		const n = missingRequiredParams.length;
		items.push({
			id: "params",
			tone: "warning",
			icon: AlertCircleIcon,
			title: `${n} required parameter${n === 1 ? "" : "s"} missing`,
			message: `Provide a value for ${missingRequiredParams.join(", ")} so this report has everything it needs.`,
			actions: [
				{
					label: "Fill in",
					onClick: handlers.onScrollToParams,
					primary: true,
				},
			],
		});
	}

	return items;
}

/**
 * Top-of-page banner(s) that make any *blocking* config problem obvious before
 * the user tries to generate: connection issues (not configured / auth expired /
 * unreachable / test failed / project not selected) and missing required
 * parameters. Connection problems spell out the two-step recovery flow (reconnect
 * the data source, then re-select the project) so users aren't left stuck after
 * completing only step 1. Each is colour-coded, carries an inline fix action, and
 * is dismissible (re-appears if the underlying state changes). Renders nothing
 * when the instance is healthy.
 */
export function ReportConfigBanner({
	readiness,
	onTest,
	onScrollToConnection,
	onScrollToParams,
	reconnectHref,
}: {
	readiness: ReportReadiness;
	onTest: () => void;
	onScrollToConnection: () => void;
	onScrollToParams: () => void;
	reconnectHref?: string;
}) {
	const items = buildItems(readiness, {
		onTest,
		onScrollToConnection,
		onScrollToParams,
		reconnectHref,
	});

	// Reset dismissals whenever the underlying issue set changes, so a freshly
	// surfaced (or re-surfaced) problem is never hidden by a stale dismissal.
	const signature = `${readiness.connection}|${readiness.missingRequiredParams.join(",")}`;
	const [dismissed, setDismissed] = useState<string[]>([]);
	useEffect(() => {
		setDismissed([]);
	}, [signature]);

	const visible = items.filter((i) => !dismissed.includes(i.id));
	if (visible.length === 0) {
		return null;
	}

	return (
		<div className="space-y-3">
			{visible.map((item) => {
				const Icon = item.icon;
				return (
					<div
						key={item.id}
						role={item.tone === "destructive" ? "alert" : "status"}
						className={cn(
							"relative flex items-start gap-3 overflow-hidden rounded-xl border p-4 pl-5",
							"motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1",
							TONE_CONTAINER[item.tone],
						)}
					>
						<span
							aria-hidden
							className={cn(
								"absolute inset-y-0 left-0 w-1",
								TONE_BAR[item.tone],
							)}
						/>
						<span
							className={cn(
								"mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg",
								TONE_ICON[item.tone],
							)}
						>
							<Icon className="size-[18px]" aria-hidden />
						</span>
						<div className="min-w-0 flex-1">
							<p className="text-sm font-semibold text-foreground">
								{item.title}
							</p>
							<p className="mt-0.5 max-w-[70ch] text-sm leading-relaxed text-muted-foreground">
								{item.message}
							</p>
						</div>
						<div className="flex shrink-0 items-center gap-2 self-center">
							{item.actions.map((action) => {
								const variant = action.primary
									? item.tone === "destructive"
										? "error"
										: "primary"
									: "ghost";
								if (action.href) {
									return (
										<Button
											key={action.label}
											asChild
											size="sm"
											variant={variant}
										>
											<Link href={action.href}>
												{action.label}
											</Link>
										</Button>
									);
								}
								return (
									<Button
										key={action.label}
										size="sm"
										variant={variant}
										onClick={action.onClick}
									>
										{action.label}
									</Button>
								);
							})}
						</div>
						<button
							type="button"
							aria-label="Dismiss"
							onClick={() =>
								setDismissed((prev) => [...prev, item.id])
							}
							className="-mr-1 -mt-1 flex size-7 shrink-0 items-center justify-center self-start rounded-md text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							<XIcon className="size-4" aria-hidden />
						</button>
					</div>
				);
			})}
		</div>
	);
}
