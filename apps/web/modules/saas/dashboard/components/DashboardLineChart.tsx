"use client";

import { Card, CardContent, CardHeader } from "@ui/components/card";
import { cn } from "@ui/lib";
import { useMemo } from "react";

interface DataPoint {
	date: string;
	count: number;
}

interface DashboardLineChartProps {
	data: DataPoint[];
	title: string;
	loading?: boolean;
	className?: string;
}

function formatDateLabel(date: string): string {
	const d = new Date(`${date}T00:00:00`);
	return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// Clamp a bezier control point's y so it never overshoots the chart bounds
function clampY(y: number, minY: number, maxY: number): number {
	return Math.min(Math.max(y, minY), maxY);
}

function catmullRomPath(
	points: { x: number; y: number }[],
	minY: number,
	maxY: number,
): string {
	if (points.length < 2) {
		return "";
	}
	const parts: string[] = [
		`M ${points[0].x.toFixed(2)},${points[0].y.toFixed(2)}`,
	];
	for (let i = 0; i < points.length - 1; i++) {
		const p0 = points[Math.max(i - 1, 0)];
		const p1 = points[i];
		const p2 = points[i + 1];
		const p3 = points[Math.min(i + 2, points.length - 1)];
		const cp1x = p1.x + (p2.x - p0.x) / 6;
		const cp1y = clampY(p1.y + (p2.y - p0.y) / 6, minY, maxY);
		const cp2x = p2.x - (p3.x - p1.x) / 6;
		const cp2y = clampY(p2.y - (p3.y - p1.y) / 6, minY, maxY);
		parts.push(
			`C ${cp1x.toFixed(2)},${cp1y.toFixed(2)} ${cp2x.toFixed(2)},${cp2y.toFixed(2)} ${p2.x.toFixed(2)},${p2.y.toFixed(2)}`,
		);
	}
	return parts.join(" ");
}

export function DashboardLineChart({
	data,
	title,
	loading,
	className,
}: DashboardLineChartProps) {
	const W = 1000;
	const H = 220;
	const pad = { top: 20, right: 24, bottom: 36, left: 52 };
	const cW = W - pad.left - pad.right;
	const cH = H - pad.top - pad.bottom;

	const baseY = pad.top + cH;
	const topY = pad.top;

	const computed = useMemo(() => {
		if (data.length < 2) {
			return {
				points: [],
				linePath: "",
				areaPath: "",
				yLabels: [],
				xLabels: [],
				total: 0,
				maxValue: 0,
			};
		}

		const total = data[data.length - 1]?.count ?? 0; // cumulative total = last value
		// Use a minimum display range of 5 so the axis always has sensible ticks
		const rawMax = Math.max(...data.map((d) => d.count), 1);
		const maxValue = Math.max(rawMax, 5);

		const mapped = data.map((d, i) => ({
			x: pad.left + (i / (data.length - 1)) * cW,
			y: pad.top + cH - (d.count / maxValue) * cH,
			date: d.date,
			count: d.count,
		}));

		const line = catmullRomPath(mapped, topY, baseY);
		const last = mapped[mapped.length - 1];
		const first = mapped[0];
		const area = `${line} L ${last.x.toFixed(2)},${baseY.toFixed(2)} L ${first.x.toFixed(2)},${baseY.toFixed(2)} Z`;

		const ySteps = 4;
		// Use index as key source to avoid duplicate-key issues when rounding collapses values
		const yLabels = Array.from({ length: ySteps + 1 }, (_, i) => ({
			idx: i,
			y: pad.top + cH - (i / ySteps) * cH,
			value: Math.round((i / ySteps) * rawMax),
		}));

		const skipFactor = Math.max(1, Math.ceil(data.length / 7));
		const xLabels = mapped.filter(
			(_, i) => i % skipFactor === 0 || i === data.length - 1,
		);

		return {
			points: mapped,
			linePath: line,
			areaPath: area,
			yLabels,
			xLabels,
			total,
			maxValue,
		};
	}, [data, cW, cH, pad.left, pad.top, baseY, topY]);

	const { points, linePath, areaPath, yLabels, xLabels, total } = computed;

	const startDate = data[0]?.date;
	const endDate = data[data.length - 1]?.date;

	if (loading) {
		return (
			<Card className={cn("overflow-hidden", className)}>
				<CardContent className="p-5">
					<div className="space-y-3">
						<div className="flex justify-between">
							<div className="h-4 w-40 animate-pulse rounded bg-muted" />
							<div className="h-4 w-32 animate-pulse rounded bg-muted" />
						</div>
						<div className="h-[200px] animate-pulse rounded-lg bg-muted" />
					</div>
				</CardContent>
			</Card>
		);
	}

	return (
		<Card className={cn("overflow-hidden", className)}>
			<CardHeader className="pb-1 pt-4 px-5">
				<div className="flex items-center justify-between gap-4 flex-wrap">
					<div className="flex items-center gap-2.5">
						<div className="h-4 w-1 rounded-full bg-primary" />
						<p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
							{title}
						</p>
					</div>
					<div className="flex items-center gap-5 text-xs text-muted-foreground">
						{startDate && (
							<span>
								Start:{" "}
								<span className="text-foreground font-semibold">
									{formatDateLabel(startDate)}
								</span>
							</span>
						)}
						{endDate && (
							<span>
								Current:{" "}
								<span className="text-foreground font-semibold">
									{formatDateLabel(endDate)}
								</span>
							</span>
						)}
						<span
							className={cn(
								"font-bold",
								total > 0
									? "text-emerald-500"
									: "text-muted-foreground",
							)}
						>
							+{total}
						</span>
					</div>
				</div>
			</CardHeader>
			<CardContent className="px-2 pb-4 pt-2">
				{data.length < 2 ? (
					<div className="flex h-[200px] items-center justify-center text-sm text-muted-foreground">
						No activity data to display
					</div>
				) : (
					<div className="text-primary">
						<svg
							viewBox={`0 0 ${W} ${H}`}
							className="w-full"
							style={{ height: "200px" }}
							role="img"
							aria-label={title}
						>
							<defs>
								<linearGradient
									id="dashboardChartGradient"
									x1="0"
									y1="0"
									x2="0"
									y2="1"
								>
									<stop
										offset="0%"
										stopColor="currentColor"
										stopOpacity="0.18"
									/>
									<stop
										offset="80%"
										stopColor="currentColor"
										stopOpacity="0.01"
									/>
								</linearGradient>
							</defs>

							{/* Bottom baseline */}
							<line
								x1={pad.left}
								y1={baseY}
								x2={W - pad.right}
								y2={baseY}
								stroke="currentColor"
								strokeOpacity="0.1"
								strokeWidth="1"
							/>

							{/* Horizontal grid lines */}
							{yLabels.map(({ idx, y, value }) => (
								<g key={`ylabel-${idx}`}>
									<line
										x1={pad.left}
										y1={y}
										x2={W - pad.right}
										y2={y}
										stroke="currentColor"
										strokeOpacity="0.05"
										strokeWidth="1"
									/>
									<text
										x={pad.left - 8}
										y={y}
										textAnchor="end"
										dominantBaseline="middle"
										fontSize="11"
										fill="var(--color-muted-foreground)"
										fillOpacity="0.8"
										fontFamily="inherit"
									>
										{value}
									</text>
								</g>
							))}

							{/* Area fill */}
							{areaPath && (
								<path
									d={areaPath}
									fill="url(#dashboardChartGradient)"
								/>
							)}

							{/* Line */}
							{linePath && (
								<path
									d={linePath}
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
									strokeLinejoin="round"
								/>
							)}

							{/* X-axis date labels */}
							{xLabels.map(({ x, date }) => (
								<text
									key={date}
									x={x}
									y={H - 4}
									textAnchor="middle"
									fontSize="10"
									fill="var(--color-muted-foreground)"
									fillOpacity="0.8"
									fontFamily="inherit"
								>
									{formatDateLabel(date)}
								</text>
							))}

							{/* Endpoint dot */}
							{points.length > 0 && (
								<circle
									cx={points[points.length - 1].x}
									cy={points[points.length - 1].y}
									r="3.5"
									fill="currentColor"
								/>
							)}
						</svg>
					</div>
				)}
			</CardContent>
		</Card>
	);
}
