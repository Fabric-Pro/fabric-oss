/**
 * Resolve a notification's stored `link` into the path to navigate to.
 *
 * Two workspace bases are in play:
 *   - **`notificationBasePath`** — the base of the notification's OWN
 *     organization (`/app` for personal, `/app/{slug}` otherwise). Context-
 *     relative links (no leading slash, e.g. `projects/…/stories/…`) resolve
 *     against it, so the destination is fixed by the notification rather than by
 *     whichever workspace the user is viewing when they click.
 *   - **`currentBasePath`** — the workspace the user is in right now. Absolute
 *     admin-area links (`/app/admin/…`) re-base onto it.
 *
 * The admin re-base exists because the active workspace is derived purely from
 * the URL slug. A notification's admin link is generated server-side (a weekly
 * digest cron, an incident writer) with no knowledge of which workspace the
 * recipient will be in when they click it, so it is always stored slug-less
 * (`/app/admin/…`). Following it verbatim would flip a system admin out of
 * their organization and into the personal workspace. The admin area is
 * mirrored under both `/app/admin/*` and `/app/{slug}/admin/*` (see the
 * `(organizations)/[organizationSlug]/admin` route tree), so re-basing onto the
 * current base always resolves to a real route and keeps the admin where they
 * are. In the personal workspace the current base is `/app`, so it is a no-op.
 *
 * @param rawLink - the notification's `link` field (may be empty/nullish).
 * @param bases - the two workspace bases:
 *   - `notificationBasePath` - the notification's own org base (`/app` or
 *     `/app/{slug}`), built from the notification's `organizationSlug`.
 *   - `currentBasePath` - the current workspace base, from `useBasePath()`.
 * @returns the path to navigate to (empty string when there is no link).
 */
export function resolveNotificationLink(
	rawLink: string | null | undefined,
	bases: { notificationBasePath: string; currentBasePath: string },
): string {
	if (!rawLink) {
		return "";
	}

	const { notificationBasePath, currentBasePath } = bases;

	// Context-relative link → prepend the notification's OWN workspace base.
	if (!rawLink.startsWith("/")) {
		return `${notificationBasePath}/${rawLink}`;
	}

	// Absolute admin-area link → re-base onto the CURRENT workspace so a system
	// admin stays in their org instead of being flipped to "Personal". Guard on
	// an exact `/app/admin` or a `/app/admin/` prefix so look-alikes such as
	// `/app/administrators` are never matched. No-op in the personal workspace
	// (current base is `/app`). The trailing slice preserves any query string.
	if (
		currentBasePath !== "/app" &&
		(rawLink === "/app/admin" || rawLink.startsWith("/app/admin/"))
	) {
		return `${currentBasePath}${rawLink.slice("/app".length)}`;
	}

	// Any other absolute link is already complete.
	return rawLink;
}
