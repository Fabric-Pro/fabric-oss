"use client";

import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Building2Icon, TrashIcon } from "lucide-react";

export type NewsletterSubscriberRowData = {
	id: string;
	email: string;
	name?: string | null;
	status: string;
	source?: string;
	excludedAt?: Date | string | null;
};

/** One subscriber row, shared by the active list and the (revealed)
 *  unsubscribed block so the markup stays in one place. */
export function NewsletterSubscriberRow({
	sub,
	onRemove,
	onSetExcluded,
}: {
	sub: NewsletterSubscriberRowData;
	onRemove: (id: string) => void;
	onSetExcluded: (id: string, excluded: boolean) => void;
}) {
	const fromOrganization = sub.source === "ORG_SYNC";
	const active = sub.status === "ACTIVE";
	const excluded = active && Boolean(sub.excludedAt);

	return (
		<li className="flex items-center justify-between gap-3 p-3">
			<div className="flex min-w-0 items-center gap-2">
				{fromOrganization && (
					<Building2Icon
						role="img"
						aria-label="Added from your organization"
						className="size-4 shrink-0 text-muted-foreground"
					/>
				)}
				<div className={excluded ? "min-w-0 opacity-60" : "min-w-0"}>
					<p className="truncate text-sm text-foreground">
						{sub.email}
					</p>
					{sub.name ? (
						<p className="truncate text-xs text-muted-foreground">
							{sub.name}
						</p>
					) : null}
				</div>
			</div>
			<div className="flex items-center gap-2">
				<Badge status={active && !excluded ? "success" : "secondary"}>
					{!active
						? "Unsubscribed"
						: excluded
							? "Excluded"
							: "Active"}
				</Badge>
				{fromOrganization && active ? (
					<Button
						variant="ghost"
						size="sm"
						aria-label={`${excluded ? "Include" : "Exclude"} ${sub.email}`}
						onClick={() => onSetExcluded(sub.id, !excluded)}
					>
						{excluded ? "Include" : "Exclude"}
					</Button>
				) : (
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={`Remove ${sub.email}`}
						onClick={() => onRemove(sub.id)}
					>
						<TrashIcon className="size-4 text-destructive" />
					</Button>
				)}
			</div>
		</li>
	);
}
