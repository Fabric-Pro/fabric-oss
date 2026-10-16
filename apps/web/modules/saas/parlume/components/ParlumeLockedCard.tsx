import { LockIcon } from "lucide-react";

/** What a reader without project-admin rights sees where the invite form would be. */
export function ParlumeLockedCard() {
	return (
		<section className="flex items-center gap-3.5 rounded-lg border border-border bg-card px-6 py-5">
			<span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
				<LockIcon className="size-4" aria-hidden="true" />
			</span>
			<div className="space-y-0.5">
				<p className="text-sm font-medium leading-5">
					Parlume is not in a meeting
				</p>
				<p className="text-[13px] leading-[18px] text-muted-foreground">
					Only project administrators can invite or remove Parlume.
				</p>
			</div>
		</section>
	);
}
