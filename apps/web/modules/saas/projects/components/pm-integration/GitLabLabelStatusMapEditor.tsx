"use client";

import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useMemo, useRef, useState } from "react";

interface ProjectStatusOption {
	id: string;
	name: string;
}

export interface GitLabLabelStatusMapEditorProps {
	/** Current map (label → statusId). */
	value: Record<string, string>;
	/** Emits the updated map on every edit. */
	onChange: (next: Record<string, string>) => void;
	/** Full list of ProjectStoryStatus rows for the current project. */
	statuses: ProjectStatusOption[];
}

interface Row {
	key: string;
	label: string;
	statusId: string;
}

/**
 * Editor for the `labelStatusMap` block inside
 * `projectManagementAdditionalContext` when the PM tool is GitLab.
 *
 * Controlled by the parent form. Empty-label rows persist locally so the user
 * can keep typing, but they are excluded from the emitted map. Duplicate
 * labels are signalled via `aria-invalid` so the parent's Save button can
 * disable itself when the map is in an inconsistent state.
 */
export function GitLabLabelStatusMapEditor({
	value,
	onChange,
	statuses,
}: GitLabLabelStatusMapEditorProps) {
	const rowKeyCounter = useRef(0);
	const nextRowKey = () => `row-${rowKeyCounter.current++}`;

	const [rows, setRows] = useState<Row[]>(() =>
		Object.entries(value).map(([label, statusId]) => ({
			key: nextRowKey(),
			label,
			statusId,
		})),
	);

	const emit = (next: Row[]) => {
		const map: Record<string, string> = {};
		for (const r of next) {
			const trimmed = r.label.trim();
			if (trimmed.length > 0 && r.statusId.length > 0) {
				map[trimmed] = r.statusId;
			}
		}
		onChange(map);
	};

	const updateRow = (idx: number, patch: Partial<Row>) => {
		const next = rows.map((r, i) => (i === idx ? { ...r, ...patch } : r));
		setRows(next);
		emit(next);
	};

	const removeRow = (idx: number) => {
		const next = rows.filter((_, i) => i !== idx);
		setRows(next);
		emit(next);
	};

	const addRow = () => {
		const next = rows.concat({
			key: nextRowKey(),
			label: "",
			statusId: statuses[0]?.id ?? "",
		});
		setRows(next);
		// Intentionally do NOT emit: an empty-label row isn't persisted
		// upstream until the user fills it in. `emit` is called by
		// `updateRow` on the next keystroke.
	};

	const duplicateLabels = useMemo(() => {
		const counts = new Map<string, number>();
		for (const r of rows) {
			const t = r.label.trim();
			if (t.length === 0) {
				continue;
			}
			counts.set(t, (counts.get(t) ?? 0) + 1);
		}
		const dupes = new Set<string>();
		for (const [label, n] of counts) {
			if (n > 1) {
				dupes.add(label);
			}
		}
		return dupes;
	}, [rows]);

	return (
		<div className="space-y-3">
			<div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
				Label → Status
			</div>
			<p className="text-muted-foreground text-xs">
				Labels are matched case-sensitively. First match wins on import.
			</p>

			<div className="space-y-2" data-testid="gitlab-label-status-rows">
				{rows.length === 0 ? (
					<p className="text-muted-foreground text-sm italic">
						No mappings configured. Features imported from GitLab
						will land in the default status.
					</p>
				) : null}

				{rows.map((row, idx) => {
					const isDuplicate = duplicateLabels.has(row.label.trim());
					return (
						<div key={row.key} className="flex items-center gap-2">
							<Input
								aria-label={`GitLab label for mapping ${idx + 1}`}
								aria-invalid={
									isDuplicate || row.label.trim().length === 0
								}
								placeholder="workflow::in-review"
								value={row.label}
								onChange={(e) =>
									updateRow(idx, { label: e.target.value })
								}
							/>
							<Select
								value={row.statusId}
								onValueChange={(v) =>
									updateRow(idx, { statusId: v })
								}
							>
								<SelectTrigger
									aria-label={`Fabric status for mapping ${idx + 1}`}
								>
									<SelectValue placeholder="Select status" />
								</SelectTrigger>
								<SelectContent>
									{statuses.map((s) => (
										<SelectItem key={s.id} value={s.id}>
											{s.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<Button
								type="button"
								variant="ghost"
								size="icon"
								aria-label={`Remove mapping ${idx + 1}`}
								onClick={() => removeRow(idx)}
							>
								<Trash2Icon className="size-4" />
							</Button>
						</div>
					);
				})}
			</div>

			<Button type="button" variant="outline" size="sm" onClick={addRow}>
				<PlusIcon className="size-4" />
				Add mapping
			</Button>
		</div>
	);
}
