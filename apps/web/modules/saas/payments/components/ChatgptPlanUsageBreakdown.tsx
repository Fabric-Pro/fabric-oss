"use client";

import { useFeatureFlag } from "@saas/shared/components/FeatureFlagProvider";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { Skeleton } from "@ui/components/skeleton";

const TOKENS = new Intl.NumberFormat("en-US", {
	notation: "compact",
	maximumFractionDigits: 1,
});

function usd(microUsd: number): string {
	const value = microUsd / 1_000_000;
	return value > 0 && value < 0.01
		? "< $0.01"
		: new Intl.NumberFormat("en-US", {
				style: "currency",
				currency: "USD",
			}).format(value);
}

export interface ChatgptPlanUsageRange {
	periodDays?: number;
	periodHours?: number;
	from?: Date;
	to?: Date;
}

/**
 * "By ChatGPT plan" (Fizzy #2972 FR4/AC5): the selected range's plan usage
 * per shared account and per member's own plan. Organization owners and
 * admins see the usage page at all; the section needs `CHATGPT_PLAN`.
 */
export function ChatgptPlanUsageBreakdown({
	range,
}: {
	range: ChatgptPlanUsageRange;
}) {
	const enabled = useFeatureFlag("CHATGPT_PLAN");
	const { data, isLoading, isError } = useQuery({
		...orpc.payments.getChatGptPlanUsage.queryOptions({ input: range }),
		enabled,
	});
	if (!enabled) {
		return null;
	}
	return (
		<Card data-testid="chatgpt-plan-usage-breakdown">
			<CardHeader className="border-b">
				<CardTitle className="font-semibold text-base">
					By ChatGPT plan
				</CardTitle>
				<p className="text-muted-foreground text-xs">
					Successful requests per subscription. Plans are billed by
					OpenAI; the cost is what the same tokens would have cost on
					API billing.
				</p>
			</CardHeader>
			<CardContent className="p-0">
				{isLoading ? (
					<Skeleton className="m-4 h-24" />
				) : isError ? (
					<p className="p-4 text-destructive text-sm" role="alert">
						Plan usage could not be loaded.
					</p>
				) : !data || data.rows.length === 0 ? (
					<p className="p-4 text-muted-foreground text-sm">
						No ChatGPT plan usage in this period.
					</p>
				) : (
					<div className="overflow-x-auto">
						<table className="w-full text-left text-sm">
							<thead className="bg-muted text-muted-foreground text-xs">
								<tr>
									<th
										className="px-4 py-2 font-medium"
										scope="col"
									>
										Subscription
									</th>
									<th
										className="px-4 py-2 text-right font-medium"
										scope="col"
									>
										Requests
									</th>
									<th
										className="px-4 py-2 text-right font-medium"
										scope="col"
									>
										Uncached input
									</th>
									<th
										className="px-4 py-2 text-right font-medium"
										scope="col"
									>
										Cached
									</th>
									<th
										className="px-4 py-2 text-right font-medium"
										scope="col"
									>
										Output
									</th>
									<th
										className="px-4 py-2 text-right font-medium"
										scope="col"
									>
										API-equivalent
									</th>
									<th
										className="px-4 py-2 text-right font-medium"
										scope="col"
									>
										Share
									</th>
								</tr>
							</thead>
							<tbody>
								{data.rows.map((row) => (
									<tr
										className="border-border border-t"
										data-testid="chatgpt-plan-usage-row"
										key={row.key}
									>
										<td className="px-4 py-2">
											<div className="font-medium">
												{row.kind === "members"
													? "Members' own plans"
													: (row.label ??
														"Unknown member")}
											</div>
											<div className="text-muted-foreground text-xs">
												{row.kind === "shared"
													? (row.detail ??
														"Shared account")
													: "Own plan"}
											</div>
										</td>
										<td className="px-4 py-2 text-right tabular-nums">
											{row.requests.toLocaleString()}
										</td>
										<td className="px-4 py-2 text-right tabular-nums">
											{TOKENS.format(
												row.uncachedInputTokens,
											)}
										</td>
										<td className="px-4 py-2 text-right tabular-nums">
											{TOKENS.format(
												row.cachedInputTokens,
											)}
										</td>
										<td className="px-4 py-2 text-right tabular-nums">
											{TOKENS.format(row.outputTokens)}
										</td>
										<td className="px-4 py-2 text-right tabular-nums">
											{usd(row.apiEquivalentCostMicroUsd)}
										</td>
										<td className="px-4 py-2 text-right tabular-nums">
											{row.sharePercent}%
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</CardContent>
		</Card>
	);
}
