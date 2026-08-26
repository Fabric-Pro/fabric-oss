import { Badge } from "@ui/components/badge";

/**
 * A prompt's tag, always the same filled green pill.
 *
 * The grid, the table and the preview sheet each rendered tags their own way —
 * per-tag hash colours in one, outlined badges in another — so a tag changed
 * appearance depending on where you saw it. One component keeps them identical,
 * and the filled style separates a tag from the outlined tier badges beside it.
 */
export function PromptTag({ children }: { children: string }) {
	return (
		<Badge className="shrink-0 border-transparent bg-secondary text-secondary-foreground">
			{children}
		</Badge>
	);
}
