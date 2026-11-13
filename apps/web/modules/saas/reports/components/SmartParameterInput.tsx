"use client";

import {
	classifyDateParameter,
	isLegacyDateParameter,
} from "@saas/reports/lib/date-parameter";
import { parameterDisplayName } from "@saas/reports/lib/report-template-defaults";
import { Badge } from "@ui/components/badge";
import { DatePicker } from "@ui/components/date-picker";
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
import { Textarea } from "@ui/components/textarea";
import { cn } from "@ui/lib";
import { format } from "date-fns";
import { AlertTriangleIcon, CheckCircle2Icon, InfoIcon } from "lucide-react";
import { PeriodParameterInput } from "./PeriodParameterInput";

// Parameter schema (JSON Schema-like)
export type ParameterSchema = {
	type: "string" | "number" | "integer" | "boolean" | "array";
	description?: string;
	default?: unknown;
	enum?: string[];
	format?: "date" | "date-time" | "email" | "uri" | "textarea";
	minimum?: number;
	maximum?: number;
	minLength?: number;
	maxLength?: number;
	pattern?: string;
};

type Props = {
	name: string;
	schema: ParameterSchema;
	value: string;
	onChange: (value: string) => void;
	isRequired?: boolean;
	isUsedInOutput?: boolean;
	className?: string;
	/**
	 * Report suite treatment: a required value that is still empty shows red,
	 * and a reporting period offers relative presets beside its date range.
	 */
	enhanced?: boolean;
};

// Detect if a parameter should use a textarea
function isLongTextParameter(name: string, schema: ParameterSchema): boolean {
	if (schema.format === "textarea") {
		return true;
	}
	const lower = name.toLowerCase();
	return (
		lower.includes("description") ||
		lower.includes("content") ||
		lower.includes("body") ||
		lower.includes("text") ||
		lower.includes("prompt")
	);
}

// Detect if a parameter is an email
function isEmailParameter(name: string, schema: ParameterSchema): boolean {
	if (schema.format === "email") {
		return true;
	}
	const lower = name.toLowerCase();
	return lower.includes("email");
}

// Detect if a parameter is a URL
function isUrlParameter(name: string, schema: ParameterSchema): boolean {
	if (schema.format === "uri") {
		return true;
	}
	const lower = name.toLowerCase();
	return (
		lower.includes("url") ||
		lower.includes("link") ||
		lower.includes("href")
	);
}

export function SmartParameterInput({
	name,
	schema,
	value,
	onChange,
	isRequired,
	isUsedInOutput,
	className,
	enhanced = false,
}: Props) {
	const hasValue = Boolean(value?.trim());
	const dateKind = enhanced ? classifyDateParameter(name, schema) : null;
	const isPeriod = dateKind === "period";
	const isDate = enhanced
		? dateKind === "date"
		: isLegacyDateParameter(name, schema);
	const hasDefault = schema.default != null && schema.default !== "";
	// A required value the server cannot fill from a default.
	const missing = enhanced && Boolean(isRequired) && !hasValue && !hasDefault;
	const descriptionId = schema.description
		? `param-${name}-description`
		: undefined;
	const fieldA11y = enhanced
		? {
				"aria-required": isRequired || undefined,
				"aria-invalid": missing || undefined,
				"aria-describedby": descriptionId,
			}
		: {};
	const isLongText = isLongTextParameter(name, schema);
	const isEmail = isEmailParameter(name, schema);
	const isUrl = isUrlParameter(name, schema);
	const isEnum = schema.enum && schema.enum.length > 0;
	const isNumber = schema.type === "number" || schema.type === "integer";
	const isBoolean = schema.type === "boolean";

	// Format display name
	const displayName = parameterDisplayName(name);

	return (
		<div className={cn("space-y-2", className)}>
			{/* Label and badges */}
			<div className="flex items-center gap-2 flex-wrap">
				<Label
					htmlFor={`param-${name}`}
					className={cn("font-medium", missing && "text-destructive")}
				>
					{displayName}
					{enhanced && isRequired && (
						<span
							aria-hidden="true"
							className="ml-1 text-destructive"
						>
							*
						</span>
					)}
				</Label>
				{isRequired &&
					(enhanced ? (
						<span
							className={cn(
								"text-xs font-medium",
								missing
									? "text-destructive"
									: "text-muted-foreground",
							)}
						>
							Required
						</span>
					) : (
						<Badge variant="secondary" className="text-xs">
							Required
						</Badge>
					))}
				{isUsedInOutput && !hasValue && (
					<Badge variant="warning" className="text-xs gap-1">
						<AlertTriangleIcon className="h-3 w-3" />
						Used in output - empty
					</Badge>
				)}
				{isUsedInOutput && hasValue && (
					<Badge variant="outline" className="text-xs text-success">
						<CheckCircle2Icon className="h-3 w-3 mr-1" />
						Used in output
					</Badge>
				)}
			</div>

			{/* Description */}
			{schema.description && (
				<p
					id={descriptionId}
					className="text-xs text-muted-foreground flex items-start gap-1"
				>
					<InfoIcon className="h-3 w-3 mt-0.5 flex-shrink-0" />
					{schema.description}
				</p>
			)}

			{/* Input based on type */}
			{isPeriod ? (
				<PeriodParameterInput
					id={`param-${name}`}
					value={value}
					onChange={onChange}
					schema={schema}
					placeholder={
						schema.default
							? String(schema.default)
							: "e.g. Sprint 42, Last 2 weeks, March 2026"
					}
					required={isRequired}
					invalid={missing}
					describedBy={descriptionId}
				/>
			) : isDate ? (
				<DatePicker
					id={`param-${name}`}
					{...fieldA11y}
					value={value || undefined}
					onChange={(date) => {
						onChange(date ? format(date, "yyyy-MM-dd") : "");
					}}
					placeholder={
						schema.default
							? String(schema.default)
							: `Select ${displayName.toLowerCase()}...`
					}
					aria-label={enhanced ? displayName : undefined}
					className={missing ? "border-destructive" : undefined}
				/>
			) : isBoolean ? (
				<div className="flex items-center gap-2">
					<Switch
						id={`param-${name}`}
						checked={value === "true"}
						onCheckedChange={(checked) =>
							onChange(checked ? "true" : "false")
						}
					/>
					<Label
						htmlFor={`param-${name}`}
						className="text-sm text-muted-foreground"
					>
						{value === "true" ? "Yes" : "No"}
					</Label>
				</div>
			) : isEnum ? (
				<Select value={value || ""} onValueChange={onChange}>
					<SelectTrigger
						id={`param-${name}`}
						className="w-full max-w-sm"
						{...fieldA11y}
					>
						<SelectValue
							placeholder={`Select ${displayName.toLowerCase()}...`}
						/>
					</SelectTrigger>
					<SelectContent>
						{schema.enum?.map((option) => (
							<SelectItem key={option} value={option}>
								{option}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			) : isLongText ? (
				<Textarea
					id={`param-${name}`}
					value={value}
					onChange={(e) => onChange(e.target.value)}
					placeholder={
						schema.default
							? String(schema.default)
							: `Enter ${displayName.toLowerCase()}...`
					}
					rows={3}
					maxLength={schema.maxLength}
					{...fieldA11y}
				/>
			) : (
				<Input
					id={`param-${name}`}
					type={
						isNumber
							? "number"
							: isEmail
								? "email"
								: isUrl
									? "url"
									: "text"
					}
					value={value}
					onChange={(e) => onChange(e.target.value)}
					placeholder={
						schema.default
							? String(schema.default)
							: `Enter ${displayName.toLowerCase()}...`
					}
					min={schema.minimum}
					max={schema.maximum}
					minLength={schema.minLength}
					maxLength={schema.maxLength}
					pattern={schema.pattern}
					className={isNumber ? "max-w-[200px]" : ""}
					{...fieldA11y}
				/>
			)}

			{/* Preview for used in output */}
			{isUsedInOutput && (
				<p className="text-xs text-muted-foreground bg-muted/50 px-2 py-1 rounded">
					<span className="font-medium">Preview in report:</span>{" "}
					{hasValue ? (
						<span className="text-foreground">{value}</span>
					) : (
						<span className="text-amber-700 dark:text-amber-400">{`{{${name}}}`}</span>
					)}
				</p>
			)}
		</div>
	);
}
