/**
 * Every account belongs to an organization.
 *
 * Nothing used to create one at signup, so a fresh account had none and landed
 * in a personal workspace. Removing that workspace is only possible once this
 * is true, which makes this the first piece of the elimination rather than a
 * convenience (Fizzy #1875, FR1a).
 *
 * IDEMPOTENT, and that is the whole design rather than a nicety. A user who
 * already belongs to somewhere is left alone, so the function can be called
 * from every point where membership might just have changed without any of
 * those callers coordinating:
 *
 *   - after signup, once invitations have been reconciled
 *   - on session creation, which is where an email+password signup's
 *     invitations are actually resolved
 *
 * The second call site is what makes this correct for INVITED users. Invitation
 * reconciliation is gated on a verified email, so a password signup has no
 * membership yet at the end of the create hook — creating an organization there
 * would hand an invited person a second, empty one, which FR1a explicitly
 * forbids. Asking "do they belong anywhere yet" at each point, rather than
 * "were they just created", is what avoids that.
 *
 * It is also the backfill. An account that predates this, with no membership,
 * gets an organization on its next sign-in, so existing users need no separate
 * migration — the same self-healing shape invitation reconciliation already
 * uses, and for the same reason.
 */

import { db, recordAudit } from "@repo/database";
import { logger } from "@repo/logs";

/**
 * The naming convention, settled 2026-08-27 and applied to every signup path
 * including the marketing site, which had proposed a second name for itself.
 * One convention is worth more than a per-funnel flourish, and two would have
 * to be reconciled by someone later.
 */
function defaultOrganizationName(
	userName: string | null | undefined,
	email: string,
): string {
	const owner = userName?.trim() || email.split("@")[0];
	return `${owner}'s workspace`;
}

/**
 * A URL-safe slug, unique by construction rather than by retrying until it
 * happens to be free.
 *
 * Built without a slug library on purpose: this runs inside the auth package,
 * which has neither of the ones the API package uses, and adding a dependency
 * to generate a hyphenated string would be a poor trade.
 */
async function uniqueSlug(name: string): Promise<string> {
	const base =
		name
			.toLowerCase()
			.normalize("NFKD")
			.replace(/[̀-ͯ]/g, "")
			// Apostrophes go before the general sweep, not through it: the
			// name is possessive, and "ada-example-s-workspace" reads worse in
			// a URL than "ada-examples-workspace" for no gain.
			.replace(/['’]/g, "")
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40) || "workspace";

	if (!(await db.organization.findFirst({ where: { slug: base } }))) {
		return base;
	}

	// Five attempts, then a slug that cannot collide. A loop that could fail is
	// a signup that could fail, and the name is cosmetic next to that.
	for (let attempt = 0; attempt < 5; attempt++) {
		const candidate = `${base}-${Math.random().toString(36).slice(2, 7)}`;
		if (
			!(await db.organization.findFirst({ where: { slug: candidate } }))
		) {
			return candidate;
		}
	}
	return `${base}-${crypto.randomUUID()}`;
}

/**
 * Give a user an organization if they have none.
 *
 * Returns the organization's id when one was created, and null when the user
 * already belonged somewhere — so a caller can log the difference without
 * asking again.
 *
 * Never throws. A failure here must not fail a signup or a sign-in: the user
 * lands where they would have landed before, and the next session heals them.
 */
/**
 * Why this is three outcomes and not `string | null`.
 *
 * `null` used to mean both "they already belong somewhere" and "creating one
 * failed", and every caller had to guess. The guess was wrong in the common
 * case: an invited user arrives already holding a membership, so the signup
 * hook logged "No organization for new user; MCP defaults will seed on their
 * next sign-in" — false in both halves, on every invited signup. A warning that
 * cries wolf on the happy path is how the real one gets ignored.
 */
export type EnsureOrganizationOutcome =
	| { outcome: "created"; organizationId: string }
	| { outcome: "already-had-one" }
	| { outcome: "failed"; reason: string };

export async function ensureUserHasOrganization(
	userId: string,
	provision: (input: {
		organizationId: string;
		userId: string;
	}) => Promise<void>,
): Promise<EnsureOrganizationOutcome> {
	try {
		const user = await db.user.findUnique({
			where: { id: userId },
			select: {
				id: true,
				name: true,
				email: true,
				members: { select: { id: true }, take: 1 },
			},
		});

		if (!user || user.members.length > 0) {
			return { outcome: "already-had-one" };
		}

		const name = defaultOrganizationName(user.name, user.email);
		const slug = await uniqueSlug(name);

		// The organization and its owner membership are written together: an
		// organization nobody belongs to is worse than no organization, because
		// it resolves and then denies.
		const organization = await db.$transaction(async (tx) => {
			const created = await tx.organization.create({
				data: { name, slug, createdAt: new Date() },
				select: { id: true, name: true, slug: true },
			});
			await tx.member.create({
				data: {
					organizationId: created.id,
					userId: user.id,
					role: "owner",
					createdAt: new Date(),
				},
			});
			return created;
		});

		// Where the post-login redirect sends them, and — since this branch —
		// what a key-authenticated caller resolves to.
		await db.user.update({
			where: { id: user.id },
			data: { lastActiveOrganizationId: organization.id },
		});

		// The same provisioning the organization plugin's own hook performs.
		// Passed in rather than imported so this module does not depend on the
		// agent packages, and so the two paths cannot drift into seeding
		// different things.
		await provision({ organizationId: organization.id, userId: user.id });

		recordAudit({
			action: "org.created",
			category: "org",
			actor: {
				type: "user",
				userId: user.id,
				emailSnapshot: user.email,
				nameSnapshot: user.name ?? null,
			},
			organizationId: organization.id,
			resource: {
				type: "organization",
				id: organization.id,
				name: organization.name,
			},
			metadata: { slug: organization.slug, autoCreated: true },
		});

		return { outcome: "created", organizationId: organization.id };
	} catch (error) {
		// Deliberately silent to the CALLER — signing in must not fail because
		// an organization could not be created, and the next session tries
		// again. Not silent to the operator: every account that lands here is
		// in the fail-closed nowhere state this epic exists to remove, and a
		// slug race or a provisioning timeout that starts happening to every
		// signup must not be something only the users notice.
		logger.error("[Auth] Could not create an organization for a user", {
			userId,
			error,
		});
		return {
			outcome: "failed",
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}
