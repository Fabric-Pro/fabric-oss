"use client";

/**
 * ActionConfigPanel Component
 *
 * Renders configuration fields for a workflow action based on its plugin definition.
 * Supports all field types: text, number, select, template-input, template-textarea,
 * ai-model-selector, and schema-builder.
 */

import {
	getProviderDisplayName,
	useAvailableModels,
} from "@shared/hooks/use-available-models";
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
import { Textarea } from "@ui/components/textarea";
import { cn } from "@ui/lib";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useCallback, useState } from "react";
import type {
	ActionConfigField,
	ActionWithContext,
} from "../lib/plugins/types";

// import { TemplateInput } from "./TemplateInput";
// import { SchemaBuilder } from "./SchemaBuilder";

// Type guard for field groups
function isFieldGroup(
	field: ActionConfigField | ActionConfigFieldGroup,
): field is ActionConfigFieldGroup {
	return (
		"fields" in field &&
		Array.isArray((field as ActionConfigFieldGroup).fields)
	);
}

// Field group type
interface ActionConfigFieldGroup {
	label: string;
	type: "group";
	fields: ActionConfigField[];
	defaultExpanded?: boolean;
}

interface VariableOption {
	label: string;
	value: string;
	description?: string;
	category?: string;
}

interface ActionConfigPanelProps {
	action: ActionWithContext;
	config: Record<string, unknown>;
	onChange: (config: Record<string, unknown>) => void;
	availableVariables?: VariableOption[];
	className?: string;
}

interface FieldGroupProps {
	label: string;
	defaultExpanded?: boolean;
	children: React.ReactNode;
}

function FieldGroup({
	label,
	defaultExpanded = false,
	children,
}: FieldGroupProps) {
	const [isOpen, setIsOpen] = useState(defaultExpanded);

	return (
		<Collapsible open={isOpen} onOpenChange={setIsOpen}>
			<CollapsibleTrigger className="flex w-full items-center justify-between rounded-md bg-muted px-3 py-2 text-sm font-medium hover:bg-muted/80">
				<span>{label}</span>
				{isOpen ? (
					<ChevronDownIcon className="h-4 w-4" />
				) : (
					<ChevronRightIcon className="h-4 w-4" />
				)}
			</CollapsibleTrigger>
			<CollapsibleContent className="space-y-3 pt-3">
				{children}
			</CollapsibleContent>
		</Collapsible>
	);
}

interface ConfigFieldProps {
	field: ActionConfigField;
	value: unknown;
	onChange: (value: unknown) => void;
	allConfig: Record<string, unknown>;
	availableVariables: VariableOption[];
}

function ConfigField({
	field,
	value,
	onChange,
	allConfig,
	availableVariables: _availableVariables,
}: ConfigFieldProps) {
	// Load available models for ai-model-selector field type
	// organizationId is auto-injected from context by useAvailableModels
	const {
		models: _models,
		modelsByProvider,
		sortedProviders,
		isLoading: modelsLoading,
	} = useAvailableModels();

	// Check showWhen condition
	if (field.showWhen) {
		const conditionValue = allConfig[field.showWhen.field];
		if (conditionValue !== field.showWhen.equals) {
			return null;
		}
	}

	const stringValue =
		value !== undefined && value !== null ? String(value) : "";

	switch (field.type) {
		case "text":
			return (
				<div className="space-y-1.5">
					<Label htmlFor={field.key}>
						{field.label}
						{field.required && (
							<span className="text-destructive ml-1">*</span>
						)}
					</Label>
					<Input
						id={field.key}
						value={stringValue}
						onChange={(e) => onChange(e.target.value)}
						placeholder={field.placeholder}
					/>
					{field.example && (
						<p className="text-muted-foreground text-xs">
							Example: {field.example}
						</p>
					)}
				</div>
			);

		case "number":
			return (
				<div className="space-y-1.5">
					<Label htmlFor={field.key}>
						{field.label}
						{field.required && (
							<span className="text-destructive ml-1">*</span>
						)}
					</Label>
					<Input
						id={field.key}
						type="number"
						value={stringValue}
						onChange={(e) =>
							onChange(Number.parseFloat(e.target.value) || 0)
						}
						placeholder={field.placeholder}
						min={field.min}
					/>
				</div>
			);

		case "select":
			return (
				<div className="space-y-1.5">
					<Label htmlFor={field.key}>
						{field.label}
						{field.required && (
							<span className="text-destructive ml-1">*</span>
						)}
					</Label>
					<Select
						value={stringValue || field.defaultValue}
						onValueChange={onChange}
					>
						<SelectTrigger id={field.key}>
							<SelectValue
								placeholder={field.placeholder || "Select..."}
							/>
						</SelectTrigger>
						<SelectContent>
							{field.options?.map(
								(option: { value: string; label: string }) => (
									<SelectItem
										key={option.value}
										value={option.value}
									>
										{option.label}
									</SelectItem>
								),
							)}
						</SelectContent>
					</Select>
				</div>
			);

		case "template-input":
			return (
				<div className="space-y-1.5">
					<Label htmlFor={field.key}>
						{field.label}
						{field.required && (
							<span className="text-destructive ml-1">*</span>
						)}
					</Label>
					<Input
						id={field.key}
						value={stringValue}
						onChange={(e) => onChange(e.target.value)}
						placeholder={field.placeholder}
					/>
					{field.example && (
						<p className="text-muted-foreground text-xs">
							Example: {field.example}
						</p>
					)}
				</div>
			);

		case "template-textarea":
			return (
				<div className="space-y-1.5">
					<Label htmlFor={field.key}>
						{field.label}
						{field.required && (
							<span className="text-destructive ml-1">*</span>
						)}
					</Label>
					<Textarea
						id={field.key}
						value={stringValue}
						onChange={(e) => onChange(e.target.value)}
						placeholder={field.placeholder}
						rows={field.rows || 3}
					/>
					{field.example && (
						<p className="text-muted-foreground text-xs">
							Example: {field.example}
						</p>
					)}
				</div>
			);

		case "ai-model-selector":
			return (
				<div className="space-y-1.5">
					<Label htmlFor={field.key}>
						{field.label}
						{field.required && (
							<span className="text-destructive ml-1">*</span>
						)}
					</Label>
					<Select
						value={stringValue || undefined}
						onValueChange={onChange}
						disabled={modelsLoading}
					>
						<SelectTrigger id={field.key}>
							<SelectValue
								placeholder={
									modelsLoading
										? "Loading models..."
										: field.placeholder || "Select model..."
								}
							/>
						</SelectTrigger>
						<SelectContent>
							{modelsLoading ? (
								<SelectItem value="loading" disabled>
									Loading models...
								</SelectItem>
							) : sortedProviders.length === 0 ? (
								<SelectItem value="no-models" disabled>
									No models available. Configure an AI
									provider in Settings.
								</SelectItem>
							) : (
								sortedProviders.map((provider) => {
									const providerModels =
										modelsByProvider[provider] || [];
									if (providerModels.length === 0) {
										return null;
									}

									return (
										<div key={provider}>
											{/* Provider group label */}
											<div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
												{getProviderDisplayName(
													provider,
												)}
											</div>
											{/* Models for this provider */}
											{providerModels.map((model) => {
												// Format model value as provider/providerModelId
												const providerPrefix = provider
													.toLowerCase()
													.replace("_direct", "");
												const modelValue = `${providerPrefix}/${model.providerModelId}`;

												return (
													<SelectItem
														key={model.id}
														value={modelValue}
													>
														{model.displayName}
														{model.speedTier && (
															<span className="ml-2 text-xs text-muted-foreground">
																(
																{model.speedTier.toLowerCase()}
																)
															</span>
														)}
													</SelectItem>
												);
											})}
										</div>
									);
								})
							)}
						</SelectContent>
					</Select>
				</div>
			);

		case "schema-builder":
			return (
				<div className="space-y-1.5">
					<Label htmlFor={field.key}>
						{field.label}
						{field.required && (
							<span className="text-destructive ml-1">*</span>
						)}
					</Label>
					<Textarea
						id={field.key}
						value={stringValue}
						onChange={(e) => onChange(e.target.value)}
						placeholder='{"type": "object", "properties": {...}}'
						rows={6}
					/>
				</div>
			);

		default:
			return null;
	}
}

export function ActionConfigPanel({
	action,
	config,
	onChange,
	availableVariables = [],
	className,
}: ActionConfigPanelProps) {
	const handleFieldChange = useCallback(
		(fieldKey: string, value: unknown) => {
			onChange({ ...config, [fieldKey]: value });
		},
		[config, onChange],
	);

	return (
		<div className={cn("space-y-4", className)}>
			{action.configFields.map(
				(
					field: ActionConfigField | ActionConfigFieldGroup,
					index: number,
				) => {
					if (isFieldGroup(field)) {
						return (
							<FieldGroup
								key={`group-${index}`}
								label={field.label}
								defaultExpanded={field.defaultExpanded}
							>
								{field.fields.map(
									(subField: ActionConfigField) => (
										<ConfigField
											key={subField.key}
											field={subField}
											value={config[subField.key]}
											onChange={(v) =>
												handleFieldChange(
													subField.key,
													v,
												)
											}
											allConfig={config}
											availableVariables={
												availableVariables
											}
										/>
									),
								)}
							</FieldGroup>
						);
					}

					return (
						<ConfigField
							key={field.key}
							field={field}
							value={config[field.key]}
							onChange={(v) => handleFieldChange(field.key, v)}
							allConfig={config}
							availableVariables={availableVariables}
						/>
					);
				},
			)}
		</div>
	);
}
