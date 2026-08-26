"use client";

/**
 * Member activity table. Presentational — receives rows
 * and sort state from UserActivityView. Timestamps render in the
 * viewer's browser timezone: relative ("3 days ago") with the absolute
 * value in the title attribute, same as AuditLogTable.
 */
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ui/components/table";
import { formatDistanceToNow } from "date-fns";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";

export type MemberActivityItem = {
	userId: string;
	name: string | null;
	email: string;
	image: string | null;
	role: string;
	lastSeenAt: Date | string | null;
	lastLoginAt: Date | string | null;
	loginCountInRange: number;
};

const ABSOLUTE_FORMAT = new Intl.DateTimeFormat(undefined, {
	dateStyle: "medium",
	timeStyle: "short",
});

export function formatActivityDate(value: Date | string | null): {
	relative: string;
	absolute: string;
	iso: string;
} | null {
	if (!value) {
		return null;
	}
	const date = typeof value === "string" ? new Date(value) : value;
	if (Number.isNaN(date.getTime())) {
		return null;
	}
	return {
		relative: formatDistanceToNow(date, { addSuffix: true }),
		absolute: ABSOLUTE_FORMAT.format(date),
		iso: date.toISOString(),
	};
}

export function MemberActivityTable({
	items,
	sortDir,
	onToggleSort,
	onSelectMember,
}: {
	items: MemberActivityItem[];
	sortDir: "asc" | "desc";
	onToggleSort: () => void;
	onSelectMember: (userId: string) => void;
}) {
	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead>Member</TableHead>
					<TableHead>Role</TableHead>
					<TableHead>
						<button
							type="button"
							className="inline-flex items-center gap-1 font-medium"
							onClick={onToggleSort}
							aria-label={`Sort by last active (${sortDir === "desc" ? "most recent first" : "most inactive first"})`}
						>
							Last active
							{sortDir === "desc" ? (
								<ArrowDownIcon className="size-3.5" />
							) : (
								<ArrowUpIcon className="size-3.5" />
							)}
						</button>
					</TableHead>
					<TableHead>Last sign-in</TableHead>
					<TableHead className="text-right">Sign-ins</TableHead>
					<TableHead />
				</TableRow>
			</TableHeader>
			<TableBody>
				{items.map((item) => {
					const lastSeen = formatActivityDate(item.lastSeenAt);
					const lastLogin = formatActivityDate(item.lastLoginAt);
					return (
						<TableRow key={item.userId}>
							<TableCell>
								<div className="flex flex-col">
									<span className="font-medium">
										{item.name ?? item.email}
									</span>
									<span className="text-xs text-muted-foreground">
										{item.email}
									</span>
								</div>
							</TableCell>
							<TableCell>
								<Badge variant="outline">{item.role}</Badge>
							</TableCell>
							<TableCell>
								{lastSeen ? (
									<time
										dateTime={lastSeen.iso}
										title={lastSeen.absolute}
									>
										{lastSeen.relative}
									</time>
								) : (
									// Never falls back to the sign-in date:
									// showing a different metric under this
									// heading is the bug this column fixes
									// (#1709).
									<Badge variant="secondary">
										Never active
									</Badge>
								)}
							</TableCell>
							<TableCell className="text-muted-foreground">
								{lastLogin ? (
									<time
										dateTime={lastLogin.iso}
										title={lastLogin.absolute}
									>
										{lastLogin.relative}
									</time>
								) : (
									<span className="text-xs">
										Never signed in
									</span>
								)}
							</TableCell>
							<TableCell className="text-right tabular-nums">
								{item.loginCountInRange}
							</TableCell>
							<TableCell className="text-right">
								<Button
									variant="ghost"
									size="sm"
									onClick={() => onSelectMember(item.userId)}
								>
									View history
								</Button>
							</TableCell>
						</TableRow>
					);
				})}
			</TableBody>
		</Table>
	);
}
