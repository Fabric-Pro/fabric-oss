"use client";

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
import type { Node } from "@xyflow/react";
import { getNodeDefinition } from "../lib/node-definitions";
import { findActionById } from "../lib/plugins/registry";
import type { ConfigField, WorkflowNodeData } from "../lib/types";
import { ActionConfigPanel } from "./ActionConfigPanel";
import { AiModelSelector } from "./config-fields/AiModelSelector";
import { CapabilitySelector } from "./config-fields/CapabilitySelector";
import { McpServerSelector } from "./config-fields/McpServerSelector";
import { McpToolSelector } from "./config-fields/McpToolSelector";

interface NodeConfigEditorProps {
	node: Node<WorkflowNodeData>;
	onUpdate: (nodeId: string, data: Partial<WorkflowNodeData>) => void;
}

/**
 * A step's editable fields. The step's identity (icon, kind) and its delete
 * action belong to the inspector around it, not to this form.
 */
export function NodeConfigEditor({ node, onUpdate }: NodeConfigEditorProps) {
	const definition = node.type ? getNodeDefinition(node.type) : undefined;
	// Plugin-backed nodes render their config from the integration's own
	// action declaration; system nodes (trigger, http-request, condition)
	// have no action and fall back to the local field renderer below.
	const action = node.type ? findActionById(node.type) : undefined;

	const handleFieldChange = (fieldName: string, value: unknown) => {
		const currentConfig =
			(node.data.config as Record<string, unknown>) || {};
		onUpdate(node.id, {
			config: {
				...currentConfig,
				[fieldName]: value,
			},
		});
	};

	const renderField = (field: ConfigField) => {
		const currentConfig =
			(node.data.config as Record<string, unknown>) || {};
		const value = currentConfig[field.name];

		switch (field.type) {
			case "text":
				return (
					<div key={field.name} className="space-y-2">
						<Label htmlFor={field.name}>
							{field.label}
							{field.required && (
								<span className="text-destructive ml-1">*</span>
							)}
						</Label>
						<Input
							id={field.name}
							value={(value as string) || ""}
							onChange={(e) =>
								handleFieldChange(field.name, e.target.value)
							}
							placeholder={field.placeholder}
						/>
						<p className="text-xs text-muted-foreground">
							Use {"{{"}NodeLabel.field{"}}"} to reference outputs
							(e.g., {"{{"}Generate Text.text{"}}"} )
						</p>
					</div>
				);

			case "textarea":
				return (
					<div key={field.name} className="space-y-2">
						<Label htmlFor={field.name}>
							{field.label}
							{field.required && (
								<span className="text-destructive ml-1">*</span>
							)}
						</Label>
						<Textarea
							id={field.name}
							value={
								typeof value === "string"
									? value
									: value === undefined
										? ""
										: JSON.stringify(value, null, 2)
							}
							onChange={(e) =>
								handleFieldChange(field.name, e.target.value)
							}
							placeholder={field.placeholder}
							rows={4}
						/>
						<p className="text-xs text-muted-foreground">
							{field.description ?? (
								<>
									Use {"{{"}NodeLabel.field{"}}"} to reference
									workflow variables
								</>
							)}
						</p>
						{!field.description && (
							<p className="text-xs text-muted-foreground mt-1">
								Examples: {"{{"}Generate Text.text{"}}"} {"{{"}
								MCP Tool.output{"}}"} {"{{"}Firecrawl
								Search.results
								{"}}"}
							</p>
						)}
					</div>
				);

			case "select":
				return (
					<div key={field.name} className="space-y-2">
						<Label htmlFor={field.name}>
							{field.label}
							{field.required && (
								<span className="text-destructive ml-1">*</span>
							)}
						</Label>
						<Select
							value={(value as string) || ""}
							onValueChange={(newValue) =>
								handleFieldChange(field.name, newValue)
							}
						>
							<SelectTrigger id={field.name}>
								<SelectValue
									placeholder={
										field.placeholder || "Select..."
									}
								/>
							</SelectTrigger>
							<SelectContent>
								{field.options?.map((option) => (
									<SelectItem
										key={option.value}
										value={option.value}
									>
										{option.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
				);

			case "number":
				return (
					<div key={field.name} className="space-y-2">
						<Label htmlFor={field.name}>
							{field.label}
							{field.required && (
								<span className="text-destructive ml-1">*</span>
							)}
						</Label>
						<Input
							id={field.name}
							type="number"
							value={(value as number) || ""}
							onChange={(e) =>
								handleFieldChange(
									field.name,
									Number.parseFloat(e.target.value),
								)
							}
							placeholder={field.placeholder}
						/>
					</div>
				);

			case "mcp-selector":
				return (
					<div key={field.name}>
						<McpServerSelector
							value={(value as string[]) || []}
							onChange={(newValue) =>
								handleFieldChange(field.name, newValue)
							}
							placeholder={field.placeholder}
						/>
					</div>
				);

			case "capability-selector":
				return (
					<div key={field.name}>
						<CapabilitySelector
							label={field.label}
							value={(value as string[]) || []}
							onChange={(newValue) =>
								handleFieldChange(field.name, newValue)
							}
						/>
					</div>
				);

			case "ai-model-selector":
				return (
					<div key={field.name}>
						<AiModelSelector
							value={(value as string) || ""}
							onChange={(newValue) =>
								handleFieldChange(field.name, newValue)
							}
							label={field.label}
							required={field.required}
							placeholder={field.placeholder}
						/>
					</div>
				);

			case "mcp-tool-selector": {
				// Get selected MCP servers from current config
				const mcpServers = (currentConfig.mcpServers as string[]) || [];
				return (
					<div key={field.name}>
						<McpToolSelector
							mcpServers={mcpServers}
							value={(value as string) || ""}
							onChange={(newValue) =>
								handleFieldChange(field.name, newValue)
							}
							required={field.required}
							placeholder={field.placeholder}
						/>
					</div>
				);
			}

			default:
				return null;
		}
	};

	return (
		<div className="space-y-4">
			{/* Node Label */}
			<div className="space-y-2">
				<Label htmlFor="node-label">Label</Label>
				<Input
					id="node-label"
					value={node.data.label || ""}
					onChange={(e) =>
						onUpdate(node.id, { label: e.target.value })
					}
					placeholder="Enter node label"
				/>
			</div>

			{/* Dynamic Config Fields.
			    A plugin-backed node renders from the action's own
			    `configFields` — that declaration is what the integration
			    author maintains, and it supports field types this editor does
			    not (template-input, schema-builder, conditional showWhen).
			    System nodes have no plugin, so they keep the local renderer. */}
			{action ? (
				<div className="space-y-4 pt-2 border-t">
					<h4 className="text-sm font-medium">Configuration</h4>
					<ActionConfigPanel
						action={action}
						config={
							(node.data.config as Record<string, unknown>) || {}
						}
						onChange={(config) => onUpdate(node.id, { config })}
					/>
				</div>
			) : (
				definition?.configFields &&
				definition.configFields.length > 0 && (
					<div className="space-y-4 pt-2 border-t">
						<h4 className="text-sm font-medium">Configuration</h4>
						{definition.configFields.map((field) =>
							renderField(field),
						)}
					</div>
				)
			)}

			{definition?.outputFields && (
				<div className="space-y-2 border-t pt-4">
					<h4 className="text-sm font-medium">Outputs</h4>
					<dl className="space-y-2 text-xs">
						{definition.outputFields.map(
							({ field, description }) => (
								<div key={field}>
									<dt>
										<code>{`{{${node.data.label || definition.label}.${field}}}`}</code>
									</dt>
									<dd className="text-muted-foreground">
										{description}
									</dd>
								</div>
							),
						)}
					</dl>
				</div>
			)}
		</div>
	);
}
