"use client";

/**
 * ChartCard - Renders chart artifacts from agents using Recharts
 *
 * Supports chart types: line, bar, pie, area, scatter
 * Receives ChartArtifact data from agent tool results and renders interactive charts.
 */

import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { cn } from "@ui/lib";
import {
	BarChart3,
	ChevronDown,
	ChevronUp,
	Download,
	LineChart as LineChartIcon,
	Maximize2,
	PieChart as PieChartIcon,
	TrendingUp,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
	Area,
	AreaChart,
	Bar,
	BarChart,
	CartesianGrid,
	Cell,
	Legend,
	Line,
	LineChart,
	Pie,
	PieChart,
	ResponsiveContainer,
	Scatter,
	ScatterChart,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";

// Vibrant chart color palette
const CHART_COLORS = [
	"#3b82f6", // blue-500
	"#22c55e", // green-500
	"#f97316", // orange-500
	"#a855f7", // purple-500
	"#ef4444", // red-500
	"#06b6d4", // cyan-500
	"#eab308", // yellow-500
	"#ec4899", // pink-500
];

interface ChartConfig {
	xAxis: string;
	yAxis: string | string[];
	title?: string;
	series?: string;
	stacked?: boolean;
	showLegend?: boolean;
}

interface ChartArtifact {
	type: "chart";
	id: string;
	chartType: "line" | "bar" | "pie" | "area" | "scatter";
	data: Record<string, unknown>[];
	config: ChartConfig;
	metadata?: {
		createdAt?: string;
		sourceDescription?: string;
		dataPointCount?: number;
		totalValue?: number;
	};
}

interface ChartCardProps {
	artifact: ChartArtifact;
	className?: string;
}

function getChartIcon(chartType: string) {
	switch (chartType) {
		case "line":
			return LineChartIcon;
		case "bar":
			return BarChart3;
		case "pie":
			return PieChartIcon;
		case "area":
			return TrendingUp;
		default:
			return BarChart3;
	}
}

function getColor(index: number): string {
	return CHART_COLORS[index % CHART_COLORS.length];
}

/**
 * Process data to ensure it has numeric values for charting.
 * Tries multiple strategies to find valid data for visualization.
 */
function processChartData(
	data: Record<string, unknown>[],
	config: ChartConfig,
): {
	data: Record<string, unknown>[];
	yAxisFields: string[];
	xAxisField: string;
	isCountBased: boolean;
} {
	const yAxisFields = Array.isArray(config.yAxis)
		? config.yAxis
		: [config.yAxis];

	if (!data || data.length === 0) {
		return {
			data: [],
			yAxisFields,
			xAxisField: config.xAxis,
			isCountBased: false,
		};
	}

	// Log received data for debugging
	console.log("[ChartCard] Processing data:", {
		rowCount: data.length,
		firstRow: data[0],
		allKeys: Object.keys(data[0] || {}),
		yAxisFields,
		xAxis: config.xAxis,
	});

	const firstRow = data[0];
	const allKeys = Object.keys(firstRow);

	// Strategy 1: Check if configured yAxis field exists and has numeric values
	const configuredYAxisExists = yAxisFields.some(
		(field) => field in firstRow,
	);
	if (configuredYAxisExists) {
		const hasNumericYAxis = yAxisFields.some((field) => {
			const value = firstRow[field];
			return (
				typeof value === "number" ||
				(typeof value === "string" && !Number.isNaN(Number(value)))
			);
		});

		if (hasNumericYAxis) {
			const processedData = data.map((row) => {
				const newRow = { ...row };
				for (const field of yAxisFields) {
					const value = row[field];
					if (typeof value === "number") {
						newRow[field] = value;
					} else if (typeof value === "string") {
						const num = Number(value);
						newRow[field] = Number.isNaN(num) ? 0 : num;
					} else {
						newRow[field] = 0;
					}
				}
				return newRow;
			});
			console.log(
				"[ChartCard] Using configured yAxis fields:",
				processedData,
			);
			return {
				data: processedData,
				yAxisFields,
				xAxisField: config.xAxis,
				isCountBased: false,
			};
		}
	}

	// Strategy 2: Auto-detect numeric fields if configured ones don't work
	const numericFields = allKeys.filter((key) => {
		const value = firstRow[key];
		return (
			typeof value === "number" ||
			(typeof value === "string" &&
				!Number.isNaN(Number(value)) &&
				value !== "")
		);
	});

	const stringFields = allKeys.filter((key) => {
		const value = firstRow[key];
		return (
			typeof value === "string" &&
			(Number.isNaN(Number(value)) || value === "")
		);
	});

	if (numericFields.length > 0 && stringFields.length > 0) {
		// Use first string field as xAxis, first numeric field as yAxis
		const autoXAxis = stringFields[0];
		const autoYAxis = numericFields[0];

		const processedData = data.map((row) => ({
			...row,
			[autoYAxis]:
				typeof row[autoYAxis] === "number"
					? row[autoYAxis]
					: Number(row[autoYAxis]) || 0,
		}));

		console.log(
			"[ChartCard] Auto-detected fields - xAxis:",
			autoXAxis,
			"yAxis:",
			autoYAxis,
			"data:",
			processedData,
		);
		return {
			data: processedData,
			yAxisFields: [autoYAxis],
			xAxisField: autoXAxis,
			isCountBased: false,
		};
	}

	// Strategy 3: Create count-based data grouped by first string field
	const labelField = stringFields[0] || config.xAxis || allKeys[0] || "item";
	const countMap = new Map<string, number>();
	for (const row of data) {
		const xValue = String(row[labelField] || row[allKeys[0]] || "Unknown");
		countMap.set(xValue, (countMap.get(xValue) || 0) + 1);
	}

	const countData = Array.from(countMap.entries()).map(([name, count]) => ({
		[labelField]: name,
		count,
	}));

	console.log(
		"[ChartCard] Created count-based data with label field:",
		labelField,
		"data:",
		countData,
	);
	return {
		data: countData,
		yAxisFields: ["count"],
		xAxisField: labelField,
		isCountBased: true,
	};
}

export function ChartCard({ artifact, className }: ChartCardProps) {
	const [isExpanded, setIsExpanded] = useState(true);
	const [isFullscreen, setIsFullscreen] = useState(false);
	const Icon = getChartIcon(artifact.chartType);

	const { config, chartType, metadata } = artifact;

	// Process data to handle non-numeric y-axis values
	const { data, yAxisFields, xAxisField, isCountBased } = useMemo(
		() => processChartData(artifact.data, config),
		[artifact.data, config],
	);

	const chartHeight = isFullscreen ? 500 : 300;

	const renderChart = useMemo(() => {
		const commonProps = {
			data: data as any[],
			margin: { top: 10, right: 30, left: 0, bottom: 0 },
		};

		switch (chartType) {
			case "line":
				return (
					<LineChart {...commonProps}>
						<CartesianGrid strokeDasharray="3 3" stroke="#e5e5e5" />
						<XAxis
							dataKey={xAxisField}
							className="text-xs"
							tick={{ fill: "#666" }}
						/>
						<YAxis className="text-xs" tick={{ fill: "#666" }} />
						<Tooltip
							contentStyle={{
								backgroundColor: "#fff",
								border: "1px solid #e5e5e5",
								borderRadius: "6px",
							}}
						/>
						{config.showLegend !== false && <Legend />}
						{yAxisFields.map((field, idx) => (
							<Line
								key={field}
								type="monotone"
								dataKey={field}
								stroke={getColor(idx)}
								strokeWidth={2}
								dot={{ r: 4, fill: getColor(idx) }}
								activeDot={{ r: 6 }}
							/>
						))}
					</LineChart>
				);

			case "bar": {
				// For single-series bar charts with categorical data, use different colors per bar
				const useCellColors =
					yAxisFields.length === 1 && data.length <= 10;
				return (
					<BarChart {...commonProps}>
						<CartesianGrid strokeDasharray="3 3" stroke="#e5e5e5" />
						<XAxis
							dataKey={xAxisField}
							className="text-xs"
							tick={{ fill: "#666" }}
						/>
						<YAxis className="text-xs" tick={{ fill: "#666" }} />
						<Tooltip
							contentStyle={{
								backgroundColor: "#fff",
								border: "1px solid #e5e5e5",
								borderRadius: "6px",
							}}
						/>
						{config.showLegend !== false &&
							yAxisFields.length > 1 && <Legend />}
						{yAxisFields.map((field, idx) => (
							<Bar
								key={field}
								dataKey={field}
								fill={getColor(idx)}
								stackId={config.stacked ? "stack" : undefined}
								radius={[4, 4, 0, 0]}
							>
								{useCellColors &&
									(data as any[]).map((_, index) => (
										<Cell
											key={`cell-${index}`}
											fill={getColor(index)}
										/>
									))}
							</Bar>
						))}
					</BarChart>
				);
			}

			case "area":
				return (
					<AreaChart {...commonProps}>
						<CartesianGrid strokeDasharray="3 3" stroke="#e5e5e5" />
						<XAxis
							dataKey={xAxisField}
							className="text-xs"
							tick={{ fill: "#666" }}
						/>
						<YAxis className="text-xs" tick={{ fill: "#666" }} />
						<Tooltip
							contentStyle={{
								backgroundColor: "#fff",
								border: "1px solid #e5e5e5",
								borderRadius: "6px",
							}}
						/>
						{config.showLegend !== false && <Legend />}
						{yAxisFields.map((field, idx) => (
							<Area
								key={field}
								type="monotone"
								dataKey={field}
								stroke={getColor(idx)}
								fill={getColor(idx)}
								fillOpacity={0.4}
								stackId={config.stacked ? "stack" : undefined}
							/>
						))}
					</AreaChart>
				);

			case "pie":
				return (
					<PieChart>
						<Pie
							data={data as any[]}
							cx="50%"
							cy="50%"
							labelLine={true}
							label={({ name, percent }) =>
								`${name}: ${((percent ?? 0) * 100).toFixed(0)}%`
							}
							outerRadius={100}
							innerRadius={40}
							dataKey={yAxisFields[0]}
							nameKey={xAxisField}
							paddingAngle={2}
						>
							{(data as any[]).map((_, index) => (
								<Cell
									key={`cell-${index}`}
									fill={getColor(index)}
								/>
							))}
						</Pie>
						<Tooltip
							contentStyle={{
								backgroundColor: "#fff",
								border: "1px solid #e5e5e5",
								borderRadius: "6px",
							}}
						/>
						{config.showLegend !== false && <Legend />}
					</PieChart>
				);

			case "scatter":
				return (
					<ScatterChart {...commonProps}>
						<CartesianGrid strokeDasharray="3 3" stroke="#e5e5e5" />
						<XAxis
							type="number"
							dataKey={xAxisField}
							name={config.xAxis}
							className="text-xs"
							tick={{ fill: "#666" }}
						/>
						<YAxis
							type="number"
							dataKey={yAxisFields[0]}
							name={yAxisFields[0]}
							className="text-xs"
							tick={{ fill: "#666" }}
						/>
						<Tooltip
							cursor={{ strokeDasharray: "3 3" }}
							contentStyle={{
								backgroundColor: "#fff",
								border: "1px solid #e5e5e5",
								borderRadius: "6px",
							}}
						/>
						<Scatter
							name={config.title || "Data"}
							data={data as any[]}
							fill={getColor(0)}
						/>
					</ScatterChart>
				);

			default:
				return null;
		}
	}, [data, config, chartType, yAxisFields]);

	const handleDownload = () => {
		const csvContent = [
			Object.keys(data[0] || {}).join(","),
			...data.map((row) => Object.values(row).join(",")),
		].join("\n");

		const blob = new Blob([csvContent], { type: "text/csv" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `${config.title || "chart"}-data.csv`;
		a.click();
		URL.revokeObjectURL(url);
	};

	return (
		<>
			<div
				className={cn(
					"rounded-lg border bg-card overflow-hidden",
					className,
				)}
			>
				{/* Header */}
				<div className="px-3 py-2 border-b bg-muted/50 flex items-center justify-between">
					<div className="flex items-center gap-2">
						<Icon className="h-4 w-4 text-muted-foreground" />
						<span className="text-sm font-medium">
							{config.title ||
								`${chartType.charAt(0).toUpperCase() + chartType.slice(1)} Chart`}
							{isCountBased && " (Count)"}
						</span>
						{(metadata?.totalValue || metadata?.dataPointCount) && (
							<span className="text-xs text-muted-foreground">
								{metadata.totalValue
									? `(${metadata.totalValue.toLocaleString()} total)`
									: `(${metadata.dataPointCount} ${chartType === "pie" || chartType === "bar" ? "categories" : "points"})`}
							</span>
						)}
					</div>

					<div className="flex items-center gap-1">
						<Button
							variant="ghost"
							size="icon-sm"
							onClick={handleDownload}
							className="h-7 w-7"
							title="Download data as CSV"
						>
							<Download className="h-3.5 w-3.5" />
						</Button>
						<Button
							variant="ghost"
							size="icon-sm"
							onClick={() => setIsFullscreen(true)}
							className="h-7 w-7"
							title="View fullscreen"
						>
							<Maximize2 className="h-3.5 w-3.5" />
						</Button>
						<Button
							variant="ghost"
							size="icon-sm"
							onClick={() => setIsExpanded(!isExpanded)}
							className="h-7 w-7"
						>
							{isExpanded ? (
								<ChevronUp className="h-3.5 w-3.5" />
							) : (
								<ChevronDown className="h-3.5 w-3.5" />
							)}
						</Button>
					</div>
				</div>

				{/* Chart */}
				{isExpanded && (
					<div className="p-4">
						<ResponsiveContainer width="100%" height={chartHeight}>
							{renderChart}
						</ResponsiveContainer>
						{metadata?.sourceDescription && (
							<p className="text-xs text-muted-foreground mt-2 text-center">
								Source: {metadata.sourceDescription}
							</p>
						)}
					</div>
				)}
			</div>

			{/* Fullscreen Dialog */}
			<Dialog open={isFullscreen} onOpenChange={setIsFullscreen}>
				<DialogContent className="max-w-4xl h-[80vh]">
					<DialogHeader>
						<DialogTitle className="flex items-center gap-2">
							<Icon className="h-5 w-5" />
							{config.title ||
								`${chartType.charAt(0).toUpperCase() + chartType.slice(1)} Chart`}
						</DialogTitle>
					</DialogHeader>
					<div className="flex-1 p-4">
						<ResponsiveContainer width="100%" height="100%">
							{renderChart}
						</ResponsiveContainer>
					</div>
				</DialogContent>
			</Dialog>
		</>
	);
}

/**
 * Type guard to check if an object is a ChartArtifact
 */
export function isChartArtifact(obj: unknown): obj is ChartArtifact {
	if (!obj || typeof obj !== "object") {
		return false;
	}
	const artifact = obj as Record<string, unknown>;
	return (
		artifact.type === "chart" &&
		typeof artifact.id === "string" &&
		typeof artifact.chartType === "string" &&
		["line", "bar", "pie", "area", "scatter"].includes(
			artifact.chartType as string,
		) &&
		Array.isArray(artifact.data) &&
		artifact.config !== null &&
		typeof artifact.config === "object"
	);
}
