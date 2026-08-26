/**
 * Small count badge overlaid on an action-bar icon button (attachments,
 * comments). Purely presentational — the parent owns the data and provides the
 * button's `relative` positioning. Renders nothing at zero so an empty icon
 * stays in its default state; caps at 99+. Shared by StoryAttachmentsButton and
 * StoryCommentsButton so the two indicators can never drift (#1778 / #1779).
 */
export function IconCountBadge({ count }: { count: number }) {
	if (count <= 0) {
		return null;
	}
	const label = count > 99 ? "99+" : String(count);
	return (
		<span
			aria-hidden
			className="pointer-events-none absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-muted-foreground px-1 font-medium text-[10px] text-background leading-none"
		>
			{label}
		</span>
	);
}
