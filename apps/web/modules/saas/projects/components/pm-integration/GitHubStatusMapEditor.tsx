"use client";

import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";

const UNMAPPED = "__unmapped__";

interface ProjectStatusOption {
	id: string;
	name: string;
}

export interface GitHubStatusOption {
	/** `Status::<option>` — the key the label map stores. */
	label: string;
	optionName: string;
}

export interface GitHubStatusMapEditorProps {
	/** Current map (`Status::<option>` → statusId). */
	value: Record<string, string>;
	onChange: (next: Record<string, string>) => void;
	/** The board's Status options, in board order. */
	options: GitHubStatusOption[];
	statuses: ProjectStatusOption[];
}

/**
 * Seed a map for a newly chosen board: each Status option maps to the Fabric
 * status of the same name (case-insensitive), when one exists. Options with
 * no namesake stay unmapped for the person to choose.
 */
export function seedGitHubStatusMap(
	options: GitHubStatusOption[],
	statuses: ProjectStatusOption[],
): Record<string, string> {
	const byName = new Map(statuses.map((s) => [s.name.toLowerCase(), s.id]));
	const map: Record<string, string> = {};
	for (const option of options) {
		const statusId = byName.get(option.optionName.toLowerCase());
		if (statusId) {
			map[option.label] = statusId;
		}
	}
	return map;
}

/**
 * Maps a GitHub Projects board's Status options to Fabric story statuses.
 * Stored in `projectManagementAdditionalContext.labelStatusMap`, the same
 * map GitLab's labels use: a push moves the board item to the option mapped
 * to the story's status, and a pull or the hourly sync moves the story.
 */
export function GitHubStatusMapEditor({
	value,
	onChange,
	options,
	statuses,
}: GitHubStatusMapEditorProps) {
	if (options.length === 0) {
		return (
			<p className="text-sm text-muted-foreground">
				This board has no Status field, so story status does not sync.
			</p>
		);
	}
	return (
		<div className="space-y-2">
			{options.map((option) => {
				const id = `github-status-${option.optionName}`;
				return (
					<div
						key={option.label}
						className="grid grid-cols-[1fr_1fr] items-center gap-2"
					>
						<Label htmlFor={id} className="truncate">
							{option.optionName}
						</Label>
						<Select
							value={value[option.label] ?? UNMAPPED}
							onValueChange={(v) => {
								const next = { ...value };
								if (v === UNMAPPED) {
									delete next[option.label];
								} else {
									next[option.label] = v;
								}
								onChange(next);
							}}
						>
							<SelectTrigger id={id}>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={UNMAPPED}>
									Not mapped
								</SelectItem>
								{statuses.map((s) => (
									<SelectItem key={s.id} value={s.id}>
										{s.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
				);
			})}
		</div>
	);
}
