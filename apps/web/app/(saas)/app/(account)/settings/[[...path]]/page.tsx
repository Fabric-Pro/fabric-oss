import {
	type AccountRedirectProps,
	redirectIntoOrganization,
} from "@saas/organizations/lib/account-route-redirect";

/**
 * Everything that used to live under `/app/settings/**`.
 *
 * The personal settings tree is gone (Fizzy #1875, FR5). This is the one route
 * left standing where twenty-one used to be, and it exists to answer for the
 * links that outlive them: bookmarks, emails, anything a person saved before
 * the tree did.
 *
 * A catch-all rather than twenty-one redirect stubs, because a stub keeps its
 * route — and its layout — alive, which is the thing the requirement asks to
 * remove. Next.js gives a real sibling route precedence over a catch-all, so
 * this only ever runs for paths that no longer exist.
 *
 * Four of the old pages are ACCOUNT-GLOBAL and move rather than merge: a
 * profile, account security, notification preferences, and account deletion
 * belong to the person, not the tenant. Two of them would collide outright if
 * mapped by slug — `general` is a profile here and an organization's settings
 * there, `danger-zone` deletes an account here and an organization there — and
 * that collision is not cosmetic: someone following a bookmark to delete their
 * account would land on the page that deletes the organization. All four go to
 * `settings/account/*`, which says whose they are.
 *
 * The rest keep their slug. Their personal-context data is being dropped, so
 * the organization's page of the same name is the only one left to show.
 */

/**
 * Old personal slug to its home inside an organization.
 *
 * Only the account-global four need naming; everything else keeps its slug, and
 * a path already shaped `account/...` passes through — that is what a link
 * built from the current base path looks like when it resolves outside an
 * organization.
 */
const ACCOUNT_GLOBAL: Record<string, string> = {
	general: "account/profile",
	security: "account/security",
	notifications: "account/notifications",
	"danger-zone": "account/danger-zone",
};

export default async function PersonalSettingsRedirect({
	params,
	searchParams,
}: AccountRedirectProps) {
	const { path } = await params;
	const query = await searchParams;

	return redirectIntoOrganization(
		"settings",
		path,
		query,
		// `/app/settings` with nothing after it was the profile page.
		(requested) =>
			requested === ""
				? "account/profile"
				: (ACCOUNT_GLOBAL[requested] ?? requested),
	);
}
