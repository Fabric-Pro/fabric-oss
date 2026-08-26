"use client";

import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { format } from "date-fns";
import { MoreVerticalIcon, PlusIcon } from "lucide-react";

export interface ConfigMeeting {
	linkedMeetingId: string;
	subject: string | null;
	includedInDigest: boolean;
	// Date over the wire may arrive serialized — parse defensively when rendering.
	lastMeetingDate: Date | string | null;
}

export function DigestConfigPanel({
	meetings,
	onSetIncluded,
	pendingIncludeIds,
	onAddMeeting,
	onUnlink,
}: {
	meetings: ConfigMeeting[];
	onSetIncluded: (linkedMeetingId: string, included: boolean) => void;
	// FIX 3 (#1898 final review): rows whose setIncluded call is in flight.
	// Disables that row's Include/Exclude button so a second click before
	// the first resolves can't send the opposite value and reverse the
	// user's intent. Optional/defaulted so callers (and existing tests)
	// that don't track in-flight state still work.
	pendingIncludeIds?: Set<string>;
	onAddMeeting: () => void;
	onUnlink: (meeting: ConfigMeeting) => void;
}) {
	return (
		<div className="space-y-2">
			<div className="flex items-center justify-between">
				<p className="text-sm text-muted-foreground">
					Meetings feeding this digest
				</p>
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={onAddMeeting}
				>
					<PlusIcon className="size-4 mr-1.5" />
					Add meeting
				</Button>
			</div>

			{!meetings.length ? (
				<p className="text-sm text-muted-foreground">
					No linked meetings yet.
				</p>
			) : (
				<ul className="divide-y rounded border">
					{meetings.map((m) => (
						<li
							key={m.linkedMeetingId}
							className="flex items-center justify-between p-2"
						>
							<div className="min-w-0">
								<p className="truncate text-sm">
									{m.subject ?? "Meeting"}
								</p>
								<p className="text-xs text-muted-foreground">
									{m.lastMeetingDate
										? `Last meeting ${format(new Date(m.lastMeetingDate), "MMM d, yyyy")}`
										: "No meetings synced yet"}
								</p>
							</div>
							<div className="flex shrink-0 items-center gap-1">
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={pendingIncludeIds?.has(
										m.linkedMeetingId,
									)}
									onClick={() =>
										onSetIncluded(
											m.linkedMeetingId,
											!m.includedInDigest,
										)
									}
								>
									{m.includedInDigest ? "Exclude" : "Include"}
								</Button>
								{/* Unlink lives behind a menu, never adjacent to
								    Exclude: Exclude is reversible, unlink deletes
								    the link and purges transcript context. */}
								<DropdownMenu>
									<DropdownMenuTrigger asChild>
										<Button
											type="button"
											variant="ghost"
											size="icon"
											aria-label={`Meeting options for ${m.subject ?? "Meeting"}`}
										>
											<MoreVerticalIcon className="size-4" />
										</Button>
									</DropdownMenuTrigger>
									<DropdownMenuContent align="end">
										<DropdownMenuItem
											className="text-destructive"
											onSelect={() => onUnlink(m)}
										>
											Unlink meeting…
										</DropdownMenuItem>
									</DropdownMenuContent>
								</DropdownMenu>
							</div>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
