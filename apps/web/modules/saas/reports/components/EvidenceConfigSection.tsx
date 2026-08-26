"use client";

import { Badge } from "@ui/components/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ui/components/card";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ui/components/collapsible";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Switch } from "@ui/components/switch";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import {
	BarChart3Icon,
	ChevronDownIcon,
	HelpCircleIcon,
	LayoutIcon,
	PaletteIcon,
	ServerIcon,
} from "lucide-react";
import { useState } from "react";

// Evidence theme configuration
export interface EvidenceTheme {
	colors?: {
		primary?: string;
		secondary?: string;
		accent?: string;
		background?: string;
		surface?: string;
		text?: string;
	};
	fonts?: {
		heading?: string;
		body?: string;
		mono?: string;
	};
	borderRadius?: string;
}

// Evidence layout configuration
export interface EvidenceLayout {
	columns?: number;
	sidebar?: boolean;
	header?: boolean;
}

// Full Evidence configuration
export interface EvidenceConfig {
	theme?: EvidenceTheme;
	layout?: EvidenceLayout;
	defaultChartType?: "line" | "bar" | "area" | "scatter" | "pie";
	componentOverrides?: Record<
		string,
		{ evidenceComponent: string; props?: Record<string, unknown> }
	>;
	useDocker?: boolean;
}

type Props = {
	value: EvidenceConfig;
	onChange: (config: EvidenceConfig) => void;
};

const CHART_TYPES = [
	{ value: "", label: "Auto (based on data)" },
	{ value: "line", label: "Line Chart", description: "Time series & trends" },
	{
		value: "bar",
		label: "Bar Chart",
		description: "Comparisons & categories",
	},
	{ value: "area", label: "Area Chart", description: "Cumulative values" },
	{ value: "scatter", label: "Scatter Plot", description: "Correlations" },
	{ value: "pie", label: "Pie Chart", description: "Proportions" },
];

const FONT_OPTIONS = [
	{ value: "", label: "Default" },
	{ value: "Inter", label: "Inter" },
	{ value: "IBM Plex Sans", label: "IBM Plex Sans" },
	{ value: "Roboto", label: "Roboto" },
	{ value: "Open Sans", label: "Open Sans" },
	{ value: "system-ui", label: "System UI" },
];

const BORDER_RADIUS_OPTIONS = [
	{ value: "", label: "Default" },
	{ value: "0px", label: "None (0px)" },
	{ value: "4px", label: "Small (4px)" },
	{ value: "8px", label: "Medium (8px)" },
	{ value: "12px", label: "Large (12px)" },
	{ value: "16px", label: "Extra Large (16px)" },
];

export function EvidenceConfigSection({ value, onChange }: Props) {
	const [isOpen, setIsOpen] = useState(true);
	const [showTheme, setShowTheme] = useState(false);
	const [showAdvanced, setShowAdvanced] = useState(false);

	const handleChange = <K extends keyof EvidenceConfig>(
		field: K,
		newValue: EvidenceConfig[K],
	) => {
		onChange({ ...value, [field]: newValue });
	};

	const handleThemeChange = (
		field: keyof EvidenceTheme,
		newValue: unknown,
	) => {
		onChange({
			...value,
			theme: { ...value.theme, [field]: newValue },
		});
	};

	const handleColorChange = (
		field: keyof NonNullable<EvidenceTheme["colors"]>,
		color: string,
	) => {
		onChange({
			...value,
			theme: {
				...value.theme,
				colors: { ...value.theme?.colors, [field]: color || undefined },
			},
		});
	};

	const handleFontChange = (
		field: keyof NonNullable<EvidenceTheme["fonts"]>,
		font: string,
	) => {
		onChange({
			...value,
			theme: {
				...value.theme,
				fonts: { ...value.theme?.fonts, [field]: font || undefined },
			},
		});
	};

	const handleLayoutChange = (
		field: keyof EvidenceLayout,
		newValue: unknown,
	) => {
		onChange({
			...value,
			layout: { ...value.layout, [field]: newValue },
		});
	};

	const hasConfig =
		value.theme ||
		value.layout ||
		value.defaultChartType ||
		value.useDocker !== undefined;

	return (
		<Card className="border-purple-200 dark:border-purple-900 bg-purple-50/30 dark:bg-purple-950/20">
			<Collapsible open={isOpen} onOpenChange={setIsOpen}>
				<CollapsibleTrigger asChild>
					<CardHeader className="cursor-pointer hover:bg-purple-100/50 dark:hover:bg-purple-900/30 transition-colors">
						<div className="flex items-center justify-between">
							<div className="flex items-center gap-2">
								<BarChart3Icon className="h-5 w-5 text-purple-600" />
								<CardTitle className="text-base">
									Evidence.dev Dashboard Settings
								</CardTitle>
								{hasConfig && (
									<Badge
										variant="secondary"
										className="text-xs bg-purple-100 dark:bg-purple-900"
									>
										Configured
									</Badge>
								)}
							</div>
							<ChevronDownIcon
								className={`h-4 w-4 transition-transform ${isOpen ? "rotate-180" : ""}`}
							/>
						</div>
						<CardDescription>
							Configure the interactive Evidence.dev dashboard
							output with custom themes and layouts
						</CardDescription>
					</CardHeader>
				</CollapsibleTrigger>

				<CollapsibleContent>
					<CardContent className="space-y-6 pt-0">
						{/* Layout Options */}
						<div className="space-y-4">
							<div className="flex items-center gap-2 text-sm font-medium">
								<LayoutIcon className="h-4 w-4" />
								Layout
							</div>
							<div className="grid gap-4 md:grid-cols-3">
								{/* Columns */}
								<div className="space-y-2">
									<TooltipProvider>
										<Tooltip>
											<TooltipTrigger asChild>
												<Label className="flex items-center gap-1 text-sm">
													Grid Columns
													<HelpCircleIcon className="h-3 w-3 text-muted-foreground" />
												</Label>
											</TooltipTrigger>
											<TooltipContent>
												<p>
													Number of columns for chart
													layout (1-4)
												</p>
											</TooltipContent>
										</Tooltip>
									</TooltipProvider>
									<Select
										value={String(
											value.layout?.columns || "",
										)}
										onValueChange={(v) =>
											handleLayoutChange(
												"columns",
												v ? Number(v) : undefined,
											)
										}
									>
										<SelectTrigger>
											<SelectValue placeholder="Auto" />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="">
												Auto
											</SelectItem>
											<SelectItem value="1">
												1 Column
											</SelectItem>
											<SelectItem value="2">
												2 Columns
											</SelectItem>
											<SelectItem value="3">
												3 Columns
											</SelectItem>
											<SelectItem value="4">
												4 Columns
											</SelectItem>
										</SelectContent>
									</Select>
								</div>

								{/* Sidebar */}
								<div className="space-y-2">
									<Label className="text-sm">
										Show Sidebar
									</Label>
									<div className="flex items-center gap-2 h-10">
										<Switch
											checked={
												value.layout?.sidebar ?? true
											}
											onCheckedChange={(checked) =>
												handleLayoutChange(
													"sidebar",
													checked,
												)
											}
										/>
										<span className="text-sm text-muted-foreground">
											{value.layout?.sidebar !== false
												? "Visible"
												: "Hidden"}
										</span>
									</div>
								</div>

								{/* Header */}
								<div className="space-y-2">
									<Label className="text-sm">
										Show Header
									</Label>
									<div className="flex items-center gap-2 h-10">
										<Switch
											checked={
												value.layout?.header ?? true
											}
											onCheckedChange={(checked) =>
												handleLayoutChange(
													"header",
													checked,
												)
											}
										/>
										<span className="text-sm text-muted-foreground">
											{value.layout?.header !== false
												? "Visible"
												: "Hidden"}
										</span>
									</div>
								</div>
							</div>
						</div>

						{/* Default Chart Type */}
						<div className="space-y-2">
							<TooltipProvider>
								<Tooltip>
									<TooltipTrigger asChild>
										<Label className="flex items-center gap-1 text-sm">
											<BarChart3Icon className="h-4 w-4" />
											Default Chart Type
											<HelpCircleIcon className="h-3 w-3 text-muted-foreground" />
										</Label>
									</TooltipTrigger>
									<TooltipContent className="max-w-xs">
										<p>
											Default chart type for
											auto-generated visualizations when
											data type is ambiguous
										</p>
									</TooltipContent>
								</Tooltip>
							</TooltipProvider>
							<Select
								value={value.defaultChartType || ""}
								onValueChange={(v) =>
									handleChange(
										"defaultChartType",
										(v as EvidenceConfig["defaultChartType"]) ||
											undefined,
									)
								}
							>
								<SelectTrigger className="max-w-xs">
									<SelectValue placeholder="Auto (based on data)" />
								</SelectTrigger>
								<SelectContent>
									{CHART_TYPES.map((t) => (
										<SelectItem
											key={t.value || "auto"}
											value={t.value || "auto"}
										>
											<div className="flex flex-col">
												<span>{t.label}</span>
												{t.description && (
													<span className="text-xs text-muted-foreground">
														{t.description}
													</span>
												)}
											</div>
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>

						{/* Theme Configuration */}
						<Collapsible
							open={showTheme}
							onOpenChange={setShowTheme}
						>
							<CollapsibleTrigger className="flex items-center gap-2 text-sm font-medium hover:text-foreground">
								<ChevronDownIcon
									className={`h-4 w-4 transition-transform ${showTheme ? "rotate-180" : ""}`}
								/>
								<PaletteIcon className="h-4 w-4" />
								Theme & Colors
								{(value.theme?.colors ||
									value.theme?.fonts) && (
									<Badge
										variant="outline"
										className="text-xs"
									>
										Customized
									</Badge>
								)}
							</CollapsibleTrigger>
							<CollapsibleContent className="mt-4 space-y-4">
								{/* Colors */}
								<div className="space-y-3">
									<Label className="text-sm text-muted-foreground">
										Colors
									</Label>
									<div className="grid grid-cols-2 md:grid-cols-3 gap-3">
										{[
											{
												key: "primary",
												label: "Primary",
												default: "#2563eb",
											},
											{
												key: "secondary",
												label: "Secondary",
												default: "#64748b",
											},
											{
												key: "accent",
												label: "Accent",
												default: "#8b5cf6",
											},
											{
												key: "background",
												label: "Background",
												default: "#ffffff",
											},
											{
												key: "surface",
												label: "Surface",
												default: "#f8fafc",
											},
											{
												key: "text",
												label: "Text",
												default: "#1e293b",
											},
										].map((color) => (
											<div
												key={color.key}
												className="space-y-1"
											>
												<Label className="text-xs">
													{color.label}
												</Label>
												<div className="flex gap-2">
													<Input
														type="color"
														value={
															value.theme
																?.colors?.[
																color.key as keyof NonNullable<
																	EvidenceTheme["colors"]
																>
															] || color.default
														}
														onChange={(e) =>
															handleColorChange(
																color.key as keyof NonNullable<
																	EvidenceTheme["colors"]
																>,
																e.target.value,
															)
														}
														className="w-10 h-8 p-1 cursor-pointer"
													/>
													<Input
														value={
															value.theme
																?.colors?.[
																color.key as keyof NonNullable<
																	EvidenceTheme["colors"]
																>
															] || ""
														}
														onChange={(e) =>
															handleColorChange(
																color.key as keyof NonNullable<
																	EvidenceTheme["colors"]
																>,
																e.target.value,
															)
														}
														placeholder={
															color.default
														}
														className="flex-1 h-8 text-xs"
													/>
												</div>
											</div>
										))}
									</div>
								</div>

								{/* Fonts */}
								<div className="space-y-3">
									<Label className="text-sm text-muted-foreground">
										Typography
									</Label>
									<div className="grid grid-cols-1 md:grid-cols-3 gap-3">
										{[
											{
												key: "heading",
												label: "Heading Font",
											},
											{ key: "body", label: "Body Font" },
											{
												key: "mono",
												label: "Monospace Font",
											},
										].map((font) => (
											<div
												key={font.key}
												className="space-y-1"
											>
												<Label className="text-xs">
													{font.label}
												</Label>
												<Select
													value={
														value.theme?.fonts?.[
															font.key as keyof NonNullable<
																EvidenceTheme["fonts"]
															>
														] || ""
													}
													onValueChange={(v) =>
														handleFontChange(
															font.key as keyof NonNullable<
																EvidenceTheme["fonts"]
															>,
															v,
														)
													}
												>
													<SelectTrigger className="h-8">
														<SelectValue placeholder="Default" />
													</SelectTrigger>
													<SelectContent>
														{FONT_OPTIONS.map(
															(f) => (
																<SelectItem
																	key={
																		f.value ||
																		"default"
																	}
																	value={
																		f.value ||
																		"default"
																	}
																>
																	{f.label}
																</SelectItem>
															),
														)}
													</SelectContent>
												</Select>
											</div>
										))}
									</div>
								</div>

								{/* Border Radius */}
								<div className="space-y-2">
									<Label className="text-xs">
										Border Radius
									</Label>
									<Select
										value={value.theme?.borderRadius || ""}
										onValueChange={(v) =>
											handleThemeChange(
												"borderRadius",
												v || undefined,
											)
										}
									>
										<SelectTrigger className="max-w-xs h-8">
											<SelectValue placeholder="Default" />
										</SelectTrigger>
										<SelectContent>
											{BORDER_RADIUS_OPTIONS.map((r) => (
												<SelectItem
													key={r.value || "default"}
													value={r.value || "default"}
												>
													{r.label}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>
							</CollapsibleContent>
						</Collapsible>

						{/* Advanced Options */}
						<Collapsible
							open={showAdvanced}
							onOpenChange={setShowAdvanced}
						>
							<CollapsibleTrigger className="flex items-center gap-2 text-sm font-medium hover:text-foreground">
								<ChevronDownIcon
									className={`h-4 w-4 transition-transform ${showAdvanced ? "rotate-180" : ""}`}
								/>
								<ServerIcon className="h-4 w-4" />
								Build Options
							</CollapsibleTrigger>
							<CollapsibleContent className="mt-4 space-y-4">
								<div className="flex items-center justify-between">
									<div className="space-y-0.5">
										<Label className="flex items-center gap-2">
											Use Docker Build
										</Label>
										<p className="text-xs text-muted-foreground">
											Build the Evidence project with
											Docker for full interactivity. Falls
											back to static HTML if unavailable.
										</p>
									</div>
									<Switch
										checked={value.useDocker !== false}
										onCheckedChange={(checked) =>
											handleChange("useDocker", checked)
										}
									/>
								</div>
							</CollapsibleContent>
						</Collapsible>

						{/* Info box */}
						<div className="bg-purple-100/50 dark:bg-purple-900/30 rounded-lg p-3 text-xs text-muted-foreground">
							<p className="font-medium mb-1 text-purple-800 dark:text-purple-200">
								About Evidence.dev Dashboards:
							</p>
							<ul className="list-disc list-inside space-y-0.5">
								<li>
									<strong>Evidence.dev</strong> creates
									interactive, data-driven dashboards
								</li>
								<li>
									Automatically generates{" "}
									<strong>charts</strong>,{" "}
									<strong>tables</strong>, and{" "}
									<strong>metrics</strong> from your data
								</li>
								<li>
									Theme settings customize colors, fonts, and
									styling
								</li>
								<li>
									Docker build provides full interactivity;
									fallback mode creates static HTML
								</li>
							</ul>
						</div>
					</CardContent>
				</CollapsibleContent>
			</Collapsible>
		</Card>
	);
}
