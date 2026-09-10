"use client";

import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { formatDistanceToNowStrict } from "date-fns";
import { useState } from "react";

/**
 * The versions of one content type, and a way back into an older one.
 *
 * A panel headed "Generated draft (version 2)" had no version 1 to open. Every
 * attempt row always persisted; `listTopicDrafts` folded them to
 * `latestAttempt` / `latestReady` and nothing else could reach them, so the
 * version number was a count of runs rather than a place you could go.
 *
 * Deliberately not a second History drawer. The Planning & Analysis tab has one
 * of those, and a third implementation of "list of versions" is what the
 * reviewer objected to in the first place — this is a short inline list under
 * the draft it belongs to, which is where the question "what did the last one
 * say?" is actually asked.
 */
export type DraftVersion = {
	id: string;
	version: number;
	createdAt: Date | string;
};

export function DraftVersions({
	versions,
	adoptedId,
	renderBody,
	onAdopt,
	isAdopting = false,
}: {
	/** Every READY generation, newest first, as the read path returns them. */
	versions: readonly DraftVersion[];
	/**
	 * The version the saved draft came from, if any — marked rather than
	 * hidden. "Which one am I holding" is the first thing this list is asked.
	 */
	adoptedId?: string | null;
	/** How to show one version's text. The document shape differs per panel. */
	renderBody: (versionId: string) => React.ReactNode;
	/**
	 * Adopt an older version as the working draft. Omitted where a version is
	 * not a single document — the short-form panels generate several options
	 * per run, so adopting means picking one of them, which is the panel's own
	 * affordance rather than this list's.
	 */
	onAdopt?: (versionId: string) => void;
	isAdopting?: boolean;
}) {
	const [openId, setOpenId] = useState<string | null>(null);

	// One version is not a history. Saying "version 1 of 1" invites a reader to
	// look for the others.
	if (versions.length < 2) {
		return null;
	}

	const open = versions.find((v) => v.id === openId) ?? null;

	return (
		<section className="space-y-2">
			<h3 className="publishing-label">Earlier versions</h3>
			<ul className="space-y-1.5">
				{versions.map((v) => {
					const created = new Date(v.createdAt);
					const isAdopted = adoptedId === v.id;
					return (
						<li
							key={v.id}
							className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-card px-3 py-2"
						>
							<span className="font-medium text-foreground text-sm">
								Version {v.version}
							</span>
							<time
								dateTime={created.toISOString()}
								className="text-muted-foreground text-xs"
							>
								{formatDistanceToNowStrict(created, {
									addSuffix: true,
								})}
							</time>
							{isAdopted ? (
								<span className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground uppercase tracking-[0.14em]">
									Saved from this
								</span>
							) : null}
							<span className="ml-auto flex items-center gap-1">
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={() => setOpenId(v.id)}
								>
									View
								</Button>
								{onAdopt && !isAdopted ? (
									<Button
										type="button"
										variant="ghost"
										size="sm"
										disabled={isAdopting}
										onClick={() => onAdopt(v.id)}
									>
										Restore
									</Button>
								) : null}
							</span>
						</li>
					);
				})}
			</ul>

			<Dialog
				open={open !== null}
				onOpenChange={(next) => {
					if (!next) {
						setOpenId(null);
					}
				}}
			>
				<DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
					<DialogHeader>
						<DialogTitle>Version {open?.version}</DialogTitle>
						<DialogDescription>
							What that run produced. Your saved draft is
							untouched until you restore this one.
						</DialogDescription>
					</DialogHeader>
					{open ? renderBody(open.id) : null}
					<DialogFooter>
						{onAdopt && open && adoptedId !== open.id ? (
							<Button
								type="button"
								disabled={isAdopting}
								onClick={() => {
									onAdopt(open.id);
									setOpenId(null);
								}}
							>
								Restore this version
							</Button>
						) : null}
						<Button
							type="button"
							variant="ghost"
							onClick={() => setOpenId(null)}
						>
							Close
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</section>
	);
}
