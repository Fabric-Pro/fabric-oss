"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Skeleton } from "@ui/components/skeleton";

// Fixed to English compact units ("2M", "250K"): some locales write a
// lowercase "m", which reads as minutes in a column about a window.
const TOKENS = new Intl.NumberFormat("en-US", {
	notation: "compact",
	maximumFractionDigits: 2,
});

function when(date: Date | string | null): string {
	return date
		? new Intl.DateTimeFormat(undefined, {
				dateStyle: "medium",
				timeStyle: "short",
			}).format(new Date(date))
		: "—";
}

interface Accuracy {
	refusalEstimatePercents: number[];
	windowsOverBudgetWithoutRefusal: number;
	settledWindows: number;
	latestReported: {
		estimatePercent: number;
		reportedPercent: number;
	} | null;
	maxDriftPoints: number | null;
}

/**
 * How well Fabric's estimate tracked OpenAI: what it said at recent
 * refusals, windows it overshot without a refusal, and the gap to the usage
 * ChatGPT reported.
 */
function EstimateAccuracy({ accuracy }: { accuracy: Accuracy }) {
	const refusals = accuracy.refusalEstimatePercents;
	return (
		<ul className="space-y-0.5 text-muted-foreground">
			<li>
				Refused at:{" "}
				{refusals.length > 0
					? refusals.map((pct) => `${Math.round(pct)}%`).join(", ")
					: "—"}
			</li>
			<li>
				Over 100% without refusal:{" "}
				{accuracy.windowsOverBudgetWithoutRefusal} of{" "}
				{accuracy.settledWindows} windows
			</li>
			<li>
				vs ChatGPT:{" "}
				{accuracy.latestReported
					? `estimate ${Math.round(accuracy.latestReported.estimatePercent)}% · reported ${Math.round(accuracy.latestReported.reportedPercent)}% · max gap ${Math.round(accuracy.maxDriftPoints ?? 0)} pts`
					: "no report"}
			</li>
		</ul>
	);
}

/**
 * Plan health (Fizzy #2770 D6): every organization's shared ChatGPT plan
 * account, read-only, for deployment admins.
 */
export function ChatgptPlanHealthList() {
	const { data, isLoading, isError } = useQuery(
		orpc.admin.chatgptPlanHealth.list.queryOptions({ input: {} }),
	);

	if (isLoading) {
		return <Skeleton className="h-40 w-full" />;
	}
	if (isError || !data) {
		return (
			<p className="text-destructive text-sm" role="alert">
				Plan health could not be loaded.
			</p>
		);
	}
	if (data.accounts.length === 0) {
		return (
			<p className="text-muted-foreground text-sm">
				No organization has connected a shared ChatGPT plan account.
			</p>
		);
	}
	return (
		<div className="overflow-x-auto rounded-lg border border-border">
			<table className="w-full text-left text-sm">
				<caption className="sr-only">
					Shared ChatGPT plan accounts across organizations
				</caption>
				<thead className="bg-muted text-muted-foreground text-xs uppercase tracking-[0.2em]">
					<tr>
						<th className="px-3 py-2 font-medium" scope="col">
							Organization
						</th>
						<th className="px-3 py-2 font-medium" scope="col">
							Account
						</th>
						<th className="px-3 py-2 font-medium" scope="col">
							Status
						</th>
						<th className="px-3 py-2 font-medium" scope="col">
							Tier
						</th>
						<th className="px-3 py-2 font-medium" scope="col">
							Paid until
						</th>
						<th className="px-3 py-2 font-medium" scope="col">
							Window
						</th>
						<th className="px-3 py-2 font-medium" scope="col">
							Resets
						</th>
						<th className="px-3 py-2 font-medium" scope="col">
							Last refused
						</th>
						<th className="px-3 py-2 font-medium" scope="col">
							Budget
						</th>
						<th className="px-3 py-2 font-medium" scope="col">
							Estimate accuracy (30 days)
						</th>
					</tr>
				</thead>
				<tbody>
					{data.accounts.map((account) => (
						<tr
							className="border-border border-t"
							data-testid="chatgpt-plan-health-row"
							key={account.id}
						>
							<td className="px-3 py-2">
								{account.organizationName}
							</td>
							<td className="px-3 py-2">
								<div className="font-medium">
									{account.label}
								</div>
								<div className="text-muted-foreground text-xs">
									{account.maskedEmail ?? "—"}
								</div>
							</td>
							<td className="px-3 py-2">
								{account.status === "NEEDS_RECONNECT" ? (
									<Badge status="warning">
										Needs reconnect
									</Badge>
								) : account.coolingUntil ? (
									<Badge status="info">
										Cooling until{" "}
										{when(account.coolingUntil)}
									</Badge>
								) : account.enabled ? (
									<Badge status="success">Active</Badge>
								) : (
									<Badge status="info">Disabled</Badge>
								)}
							</td>
							<td className="px-3 py-2">
								{account.tier === "UNKNOWN"
									? "—"
									: account.tier.charAt(0) +
										account.tier.slice(1).toLowerCase()}
							</td>
							<td className="px-3 py-2">
								{account.subscriptionActiveUntil
									? new Intl.DateTimeFormat(undefined, {
											dateStyle: "medium",
										}).format(
											new Date(
												account.subscriptionActiveUntil,
											),
										)
									: "—"}
							</td>
							<td className="px-3 py-2 tabular-nums">
								<div>{account.windowPercent}%</div>
								<div
									className="text-muted-foreground text-xs"
									data-testid="chatgpt-plan-health-source"
								>
									{account.windowPercentSource === "reported"
										? `reported by ChatGPT · estimate ${account.estimatedPercent}%`
										: "estimated"}
								</div>
							</td>
							<td className="px-3 py-2">
								{when(account.resetsAt)}
							</td>
							<td className="px-3 py-2">
								{when(account.lastExhaustedAt)}
							</td>
							<td className="px-3 py-2 tabular-nums">
								{TOKENS.format(account.budget)} tokens
								<span className="text-muted-foreground text-xs">
									{account.budgetCalibrated
										? " · calibrated"
										: " · default"}
								</span>
							</td>
							<td
								className="px-3 py-2 text-xs"
								data-testid="chatgpt-plan-health-accuracy"
							>
								<EstimateAccuracy accuracy={account.accuracy} />
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
