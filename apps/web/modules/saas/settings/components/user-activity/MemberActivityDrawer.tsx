"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
/**
 * Per-member login history drawer. Daily login volume as
 * an area chart (recharts, config copied from AiUsageActivityView) plus
 * the most recent login/logout events with IP + user agent from the
 * audit rows. Query only runs while the drawer is open.
 */
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@ui/components/sheet";
import { Skeleton } from "@ui/components/skeleton";
import {
	Area,
	AreaChart,
	CartesianGrid,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { formatActivityDate } from "./MemberActivityTable";

export function MemberActivityDrawer({
	organizationId,
	userId,
	rangeDays,
	onClose,
}: {
	organizationId: string;
	userId: string | null;
	rangeDays: 7 | 30 | 90;
	onClose: () => void;
}) {
	const { data, isPending, isError } = useQuery({
		...orpc.userActivity.memberHistory.queryOptions({
			input: {
				organizationId,
				userId: userId ?? "",
				rangeDays,
			},
		}),
		enabled: userId !== null,
	});

	return (
		<Sheet
			open={userId !== null}
			onOpenChange={(open) => {
				if (!open) {
					onClose();
				}
			}}
		>
			<SheetContent className="flex w-full flex-col gap-4 overflow-y-auto sm:max-w-xl">
				{isPending && userId !== null ? (
					<>
						{/* Radix requires a title/description in every open state. */}
						<SheetHeader className="sr-only">
							<SheetTitle>Login history</SheetTitle>
							<SheetDescription>
								Loading login history…
							</SheetDescription>
						</SheetHeader>
						<div className="flex flex-col gap-3 pt-8">
							<Skeleton className="h-6 w-48" />
							<Skeleton className="h-40 w-full" />
						</div>
					</>
				) : isError ? (
					<SheetHeader>
						<SheetTitle>Login history</SheetTitle>
						<SheetDescription>
							Could not load login history.
						</SheetDescription>
					</SheetHeader>
				) : data ? (
					<>
						<SheetHeader>
							<SheetTitle>
								{data.user.name ?? data.user.email}
							</SheetTitle>
							<SheetDescription>
								{data.user.email} ·{" "}
								<Badge variant="outline">{data.role}</Badge>
							</SheetDescription>
						</SheetHeader>
						<div className="flex flex-col gap-1">
							<p className="text-sm">
								Last active: {(() => {
									const seen = formatActivityDate(
										data.lastSeenAt,
									);
									return seen ? (
										<time
											dateTime={seen.iso}
											title={seen.absolute}
											className="font-medium"
										>
											{seen.relative}
										</time>
									) : (
										<span className="font-medium">
											Never active
										</span>
									);
								})()}
							</p>
							<p className="text-sm text-muted-foreground">
								{data.totalLoginsInRange} sign-ins in the last{" "}
								{rangeDays} days
							</p>
						</div>
						{data.totalLoginsInRange === 0 ? (
							<p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
								No sign-ins in this period.
							</p>
						) : (
							// shrink-0: inside this flex-col overflow body the
							// (initially empty) chart div otherwise collapses to 0
							// height and ResponsiveContainer renders nothing.
							<div className="h-48 w-full shrink-0">
								<ResponsiveContainer width="100%" height="100%">
									<AreaChart data={data.buckets}>
										<CartesianGrid
											strokeDasharray="3 3"
											className="stroke-muted"
										/>
										<XAxis
											dataKey="day"
											tick={{ fontSize: 11 }}
											tickLine={false}
										/>
										<YAxis
											allowDecimals={false}
											width={28}
											tick={{ fontSize: 11 }}
											tickLine={false}
										/>
										<Tooltip />
										<Area
											type="monotone"
											dataKey="count"
											name="Sign-ins"
											stroke="var(--primary)"
											fill="var(--primary)"
											fillOpacity={0.15}
										/>
									</AreaChart>
								</ResponsiveContainer>
							</div>
						)}
						{data.recentEvents.length > 0 && (
							<div className="flex flex-col gap-2">
								<h4 className="text-sm font-semibold">
									Recent events
								</h4>
								<ul className="flex flex-col gap-2">
									{data.recentEvents.map((event, index) => {
										const when = formatActivityDate(
											event.createdAt,
										);
										return (
											<li
												key={`${event.createdAt}-${index}`}
												className="flex flex-col gap-0.5 rounded-md border p-2 text-xs"
											>
												<div className="flex items-center justify-between gap-2">
													<Badge
														variant={
															event.action ===
															"auth.logout"
																? "secondary"
																: "outline"
														}
													>
														{event.action ===
														"auth.logout"
															? "Logout"
															: "Login"}
													</Badge>
													<time
														dateTime={when?.iso}
														title={when?.absolute}
														className="text-muted-foreground"
													>
														{when?.relative}
													</time>
												</div>
												<div className="flex items-center justify-between gap-2 text-muted-foreground">
													<span>
														{event.ipAddress ??
															"IP unknown"}
													</span>
													<span className="max-w-56 truncate">
														{event.userAgent ?? ""}
													</span>
												</div>
											</li>
										);
									})}
								</ul>
							</div>
						)}
					</>
				) : null}
			</SheetContent>
		</Sheet>
	);
}
