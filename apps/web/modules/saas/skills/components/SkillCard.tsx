"use client";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { PuzzleIcon } from "@saas/shared/components/icons/PuzzleIcon";
import { Badge } from "@ui/components/badge";
import Link from "next/link";
import { type SkillListItem, skillAvailabilityLabel } from "../lib/skill-ui";
export function SkillCard({
	skill,
	onSelect,
}: {
	skill: SkillListItem;
	onSelect?: (id: string) => void;
	onUpdate?: () => void;
}) {
	const { basePath } = useOrganizationContext();
	return (
		<li className="min-w-0 rounded-lg border border-border bg-card">
			<Link
				prefetch={false}
				aria-haspopup={onSelect ? "dialog" : undefined}
				className="block space-y-3 rounded-lg p-5 transition-colors hover:bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
				href={`${basePath}/skills/${encodeURIComponent(skill.id)}`}
				onClick={(event) => {
					if (
						onSelect &&
						!event.metaKey &&
						!event.ctrlKey &&
						!event.shiftKey &&
						!event.altKey &&
						event.button === 0
					) {
						event.preventDefault();
						onSelect(skill.id);
					}
				}}
			>
				<div className="flex items-start justify-between gap-3">
					<div className="flex min-w-0 items-center gap-2">
						<PuzzleIcon
							className="size-5 shrink-0 text-muted-foreground"
							aria-hidden="true"
						/>
						<h2 className="truncate text-sm font-semibold">
							{skill.name}
						</h2>
					</div>
					<Badge variant="outline">
						{skill.archivedAt
							? "Archived"
							: skillAvailabilityLabel(skill.availability)}
					</Badge>
				</div>
				<p className="line-clamp-3 break-words text-sm text-muted-foreground">
					{skill.description}
				</p>
				<div className="flex min-w-0 flex-wrap gap-1">
					{skill.tags.slice(0, 3).map((tag) => (
						<Badge
							key={tag}
							variant="secondary"
							className="max-w-32 truncate font-sans"
						>
							{tag}
						</Badge>
					))}
					{skill.tags.length > 3 && (
						<span className="text-xs text-muted-foreground">
							+{skill.tags.length - 3} more
						</span>
					)}
				</div>
				<p className="text-xs text-muted-foreground">
					Version {skill.version} · Updated{" "}
					{new Date(skill.updatedAt).toLocaleDateString()}
				</p>
			</Link>
		</li>
	);
}
