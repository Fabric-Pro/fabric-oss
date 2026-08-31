import { getOrganizationList, getSession } from "@saas/auth/lib/server";
import { redirect } from "next/navigation";

/**
 * Where a link into the retired personal route tree should land now.
 *
 * Personal context is gone (Fizzy #1875). Sixteen route trees under the account
 * group went with it, and this is what stands in their place: one redirect per
 * tree, resolving the caller's organization and rebuilding the same path inside
 * it, so bookmarks, emails and hardcoded callbacks still arrive somewhere.
 *
 * ## Why a catch-all under each name, and not one at the top
 *
 * One catch-all at the account group's root would be the smaller shape, and it
 * is the shape the plan called for. It cannot be built, for two independent
 * reasons, both established by trying it rather than by reading the router:
 *
 * 1. Next refuses it outright. `/app/[...rest]` already exists, and a required
 *    and an optional catch-all may not sit at the same level — the dev server
 *    fails to compile, it is not a precedence question.
 * 2. Even reusing `[...rest]` itself does not work, because it never receives
 *    these requests. A probe that returned a marker from it was never reached,
 *    not even by a path matching nothing at all: `/app/{anything}` is claimed
 *    first by `[organizationSlug]`, whose layout fails to resolve the segment
 *    as a slug and returns the 404.
 *
 * A catch-all one level DOWN does work, because it sits behind a STATIC segment
 * and static outranks the dynamic organization slug. So `prompts/[[...path]]`
 * claims `/app/prompts` and everything under it, while `[organizationSlug]`
 * keeps the rest. One file per retired tree is therefore the smallest shape the
 * router allows, not a preference.
 */
export async function redirectIntoOrganization(
	base: string,
	segments: string[] | undefined,
	query: Record<string, string | string[] | undefined>,
	/**
	 * Old sub-path to its new home, for the pages that MOVED rather than
	 * merged. Only the settings tree needs this; everything else keeps its
	 * shape inside the organization.
	 */
	rewrite?: (requested: string) => string,
): Promise<never> {
	const session = await getSession();
	if (!session) {
		redirect("/auth/login");
	}

	const organizations = await getOrganizationList();
	const target =
		organizations.find(
			(organization) =>
				organization.id === session.session.activeOrganizationId,
		) ?? organizations[0];

	// No organization to redirect into. Every account gets one at signup and on
	// sign-in, so this is the narrow window where that has not happened yet —
	// the creation page is where the rest of the app sends such a user too.
	if (!target) {
		redirect("/new-organization");
	}

	const requested = (segments ?? []).join("/");
	const rewritten = rewrite ? rewrite(requested) : requested;
	const path = [base, rewritten].filter(Boolean).join("/");

	// Query strings are carried through: the two-factor enforcement redirect
	// arrives here with `mfaRequired` and `from`, and dropping them would land
	// the user on a page that no longer explains why they are on it. Project
	// links carry `tab` and `step` for the same reason.
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(query)) {
		if (typeof value === "string") {
			search.set(key, value);
		} else if (Array.isArray(value)) {
			for (const entry of value) {
				search.append(key, entry);
			}
		}
	}
	const suffix = search.size > 0 ? `?${search.toString()}` : "";

	redirect(`/app/${target.slug}/${path}${suffix}`);
}

/**
 * The props every one of these redirect routes receives. Named here so the
 * sixteen call sites do not each restate it.
 */
export type AccountRedirectProps = {
	params: Promise<{ path?: string[] }>;
	searchParams: Promise<Record<string, string | string[] | undefined>>;
};
