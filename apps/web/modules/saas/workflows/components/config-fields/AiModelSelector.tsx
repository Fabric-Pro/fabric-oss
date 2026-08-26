"use client";

import { GatewayModelSelector } from "@shared/components/GatewayModelSelector";

interface AiModelSelectorProps {
	value: string;
	onChange: (value: string) => void;
	label?: string;
	required?: boolean;
	placeholder?: string;
}

/**
 * AI Model selector for workflow editor.
 * Uses the shared GatewayModelSelector component.
 */
export function AiModelSelector({
	value,
	onChange,
	label = "Model",
	required = false,
	placeholder = "Select a model...",
}: AiModelSelectorProps) {
	return (
		<GatewayModelSelector
			value={value}
			onChange={onChange}
			label={label}
			required={required}
			placeholder={placeholder}
			className="space-y-2"
		/>
	);
}
