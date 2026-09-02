"use client";

import type { DocumentType } from "@repo/agent-types";
import { Button } from "@ui/components/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import { ChevronDown } from "lucide-react";
import { useState } from "react";

const documentTypes: { value: DocumentType; label: string; emoji: string }[] = [
	{ value: "general", label: "General", emoji: "📄" },
	{ value: "business_case", label: "Business Case", emoji: "📊" },
	{ value: "design_system", label: "Design System", emoji: "🎨" },
	{ value: "prd", label: "PRD", emoji: "📋" },
	{ value: "proposal", label: "Proposal", emoji: "💼" },
	{ value: "architecture", label: "Architecture", emoji: "🏗️" },
	{ value: "technical_spec", label: "Technical Spec", emoji: "⚙️" },
	{ value: "user_story", label: "Feature", emoji: "🧑‍💻" },
	{ value: "api_spec", label: "API Spec", emoji: "🔌" },
];

interface CompactDocumentTypeSelectorProps {
	value: DocumentType;
	onChange: (value: DocumentType) => void;
	disabled?: boolean;
}

export function CompactDocumentTypeSelector({
	value,
	onChange,
	disabled,
}: CompactDocumentTypeSelectorProps) {
	const [open, setOpen] = useState(false);
	const selectedType =
		documentTypes.find((type) => type.value === value) || documentTypes[0];

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					variant="outline"
					size="sm"
					disabled={disabled}
					className="gap-2 h-8 px-2"
				>
					<span className="text-base">{selectedType.emoji}</span>
					<span className="text-xs font-medium hidden sm:inline">
						{selectedType.label}
					</span>
					<ChevronDown className="h-3 w-3 opacity-50" />
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-56 p-1" align="start">
				<div className="space-y-1">
					{documentTypes.map((type) => (
						<button
							key={type.value}
							type="button"
							onClick={() => {
								onChange(type.value);
								setOpen(false);
							}}
							className={`w-full flex items-center gap-3 px-3 py-2 rounded text-left transition-colors ${
								value === type.value
									? "bg-primary/10 text-primary"
									: "hover:bg-muted"
							}`}
						>
							<span className="text-base">{type.emoji}</span>
							<span className="text-sm font-medium">
								{type.label}
							</span>
						</button>
					))}
				</div>
			</PopoverContent>
		</Popover>
	);
}
