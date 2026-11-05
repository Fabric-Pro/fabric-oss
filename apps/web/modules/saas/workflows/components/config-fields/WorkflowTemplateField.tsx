"use client";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import { Textarea } from "@ui/components/textarea";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import type { OutputOption } from "../../lib/output-options";
export function WorkflowTemplateField({
	id,
	value,
	onChange,
	options,
	multiline = false,
	placeholder,
	rows = 4,
}: {
	id: string;
	value: string;
	onChange: (value: string) => void;
	options: OutputOption[];
	multiline?: boolean;
	placeholder?: string;
	rows?: number;
}) {
	const t = useTranslations("workflows.authoring");
	const copy = (key: string, fallback: string) =>
		t.has(key) ? t(key) : fallback;
	const input = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const filtered = options.filter((o) =>
		`${o.category ?? ""} ${o.label} ${o.description ?? ""}`
			.toLowerCase()
			.includes(query.toLowerCase()),
	);
	const insert = (token: string) => {
		const start = input.current?.selectionStart ?? value.length;
		const end = input.current?.selectionEnd ?? start;
		onChange(value.slice(0, start) + token + value.slice(end));
		setOpen(false);
		requestAnimationFrame(() => {
			input.current?.focus();
			input.current?.setSelectionRange(
				start + token.length,
				start + token.length,
			);
		});
	};
	return (
		<div className="space-y-2">
			{multiline ? (
				<Textarea
					ref={(el) => {
						input.current = el;
					}}
					id={id}
					value={value}
					onChange={(e) => onChange(e.target.value)}
					placeholder={placeholder}
					rows={rows}
				/>
			) : (
				<Input
					ref={(el) => {
						input.current = el;
					}}
					id={id}
					value={value}
					onChange={(e) => onChange(e.target.value)}
					placeholder={placeholder}
				/>
			)}
			<Popover open={open} onOpenChange={setOpen}>
				<PopoverTrigger asChild>
					<Button type="button" variant="outline" size="sm">
						{copy("insert", "Insert output")}
					</Button>
				</PopoverTrigger>
				<PopoverContent
					className="w-80 max-w-full space-y-3"
					align="start"
				>
					<Input
						aria-label={copy(
							"searchOutputs",
							"Search step outputs",
						)}
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder={copy(
							"searchPlaceholder",
							"Search step outputs…",
						)}
					/>
					<div
						className="max-h-64 space-y-1 overflow-auto"
						role="group"
						aria-label="Available step outputs"
					>
						{filtered.map((o) => (
							<Button
								type="button"
								variant="ghost"
								key={o.value}
								className="h-auto w-full justify-start whitespace-normal text-left"
								onClick={() => insert(o.value)}
							>
								<span>
									<span className="block font-medium">
										{o.category} · {o.label}
									</span>
									<span className="block text-xs text-muted-foreground">
										{o.description}
									</span>
								</span>
							</Button>
						))}
						{options.length > 0 && filtered.length === 0 && (
							<p className="text-sm text-muted-foreground">
								{copy("noMatches", "No matching outputs.")}
							</p>
						)}
						{!options.length && (
							<p className="text-sm text-muted-foreground">
								{copy(
									"noOutputs",
									"Connect an earlier step to use its output here.",
								)}
							</p>
						)}
					</div>
				</PopoverContent>
			</Popover>
		</div>
	);
}
