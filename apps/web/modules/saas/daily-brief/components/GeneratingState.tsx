"use client";

/**
 * GeneratingState — shown while the Daily Brief workflow is still running.
 *
 * A11y:
 * - Uses the `<output>` element, which has an implicit `role="status"`
 *   and (with the explicit `aria-live="polite"`) politely announces phase
 *   transitions without interrupting the user.
 *
 * The `phase` prop is eventually wired to the workflow progress query; for
 * now it's a plain string supplied by the caller.
 */

export interface GeneratingStateProps {
	/** Optional phase text, e.g. "Collecting GitHub activity…". */
	phase?: string;
}

export function GeneratingState({ phase }: GeneratingStateProps) {
	return (
		<output
			aria-live="polite"
			aria-atomic="true"
			className="flex flex-col items-center justify-center rounded-2xl border border-border bg-card p-12 text-center"
		>
			<div className="flex items-center gap-1.5" aria-hidden="true">
				<span className="size-2 rounded-full bg-muted-foreground/40 motion-safe:animate-bounce [animation-delay:0ms]" />
				<span className="size-2 rounded-full bg-muted-foreground/40 motion-safe:animate-bounce [animation-delay:150ms]" />
				<span className="size-2 rounded-full bg-muted-foreground/40 motion-safe:animate-bounce [animation-delay:300ms]" />
			</div>
			<p className="mt-5 font-serif text-xl font-normal leading-tight text-foreground">
				Generating your brief…
			</p>
			<p className="mt-2 text-sm text-muted-foreground">
				{phase ?? "Collecting activity from your project sources."}
			</p>
		</output>
	);
}
