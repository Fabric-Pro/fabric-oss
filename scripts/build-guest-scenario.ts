#!/usr/bin/env npx tsx
/**
 * A project-only guest, built the way one actually comes into being.
 *
 * Verifies the premise the elimination's remaining guest work now rests on: a
 * guest is defined RELATIVE to the host organization — no membership there, an
 * accepted project membership there — so after every account gets an
 * organization at signup, guests still exist and each has one of their own.
 *
 * Both accounts are created through the real signup path rather than by
 * inserting rows, so the auto-organization hook fires exactly as it does in
 * production. Inserting the rows by hand would have proved nothing about the
 * thing being checked.
 *
 * Local only. Prints what it made, and what the guest's session should carry.
 *
 * Lived under `local/` while it was being written, which is gitignored — so the
 * harness that found the guest defects did not travel with the change that
 * fixed them. It is here now: a reviewer who wants to see a guest's chrome, or
 * the next person to touch the guest branches, should not have to rebuild it.
 *
 * Usage:
 *   DATABASE_URL=... pnpm exec tsx scripts/build-guest-scenario.ts
 */

import { auth } from "@repo/auth";
import { db } from "@repo/database";

const OWNER = { email: "owner@example.com", password: "TestPassword123!" };
const GUEST = { email: "guest@example.com", password: "TestPassword123!" };

async function signUp(
	email: string,
	password: string,
	name: string,
): Promise<string> {
	const existing = await db.user.findUnique({ where: { email } });
	if (existing) {
		return existing.id;
	}
	await auth.api.signUpEmail({ body: { email, password, name } });
	const created = await db.user.findUnique({ where: { email } });
	if (!created) {
		throw new Error(`signup did not create ${email}`);
	}
	// Verified so the invitation-reconciliation path behaves as it would for a
	// magic-link or OAuth arrival, and so sign-in is not gated on an email.
	await db.user.update({
		where: { id: created.id },
		data: { emailVerified: true, mustChangePassword: false },
	});
	return created.id;
}

async function main(): Promise<void> {
	const ownerId = await signUp(OWNER.email, OWNER.password, "Owner Example");
	const guestId = await signUp(GUEST.email, GUEST.password, "Guest Example");

	// The auto-organization hook runs on signup; a second call at sign-in heals
	// anything it missed. Read what each of them actually got.
	const [ownerMemberships, guestMemberships] = await Promise.all([
		db.member.findMany({
			where: { userId: ownerId },
			select: { organization: { select: { id: true, slug: true } } },
		}),
		db.member.findMany({
			where: { userId: guestId },
			select: { organization: { select: { id: true, slug: true } } },
		}),
	]);

	const hostOrg = ownerMemberships[0]?.organization;
	const guestOrg = guestMemberships[0]?.organization;
	if (!hostOrg) {
		throw new Error(
			"the owner has no organization — the signup hook did not run",
		);
	}

	// A project in the host organization, owned by the owner.
	const project =
		(await db.project.findFirst({
			where: { name: "Shared Example Project", userId: ownerId },
		})) ??
		(await db.project.create({
			data: {
				name: "Shared Example Project",
				userId: ownerId,
				organizationId: hostOrg.id,
			},
		}));

	// The guest's only access: an accepted membership on that one project.
	const membership = await db.projectMember.findFirst({
		where: { projectId: project.id, userId: guestId },
	});
	if (!membership) {
		await db.projectMember.create({
			data: {
				projectId: project.id,
				userId: guestId,
				role: "VIEWER",
				invitedBy: ownerId,
				acceptedAt: new Date(),
			},
		});
	}

	const isGuest =
		!(await db.member.findFirst({
			where: { organizationId: hostOrg.id, userId: guestId },
		})) &&
		!!(await db.projectMember.findFirst({
			where: {
				userId: guestId,
				acceptedAt: { not: null },
				project: { organizationId: hostOrg.id },
			},
		}));

	const guestUser = await db.user.findUnique({
		where: { id: guestId },
		select: { lastActiveOrganizationId: true },
	});

	console.log("\nGuest scenario");
	console.log("==============\n");
	console.log(
		`Owner .................... ${OWNER.email} / ${OWNER.password}`,
	);
	console.log(`  host organization ...... ${hostOrg.slug} (${hostOrg.id})`);
	console.log(`  shared project ......... ${project.id}`);
	console.log(
		`\nGuest .................... ${GUEST.email} / ${GUEST.password}`,
	);
	console.log(
		`  own organization ....... ${guestOrg ? `${guestOrg.slug} (${guestOrg.id})` : "NONE — the premise fails"}`,
	);
	console.log(
		`  last-active org ........ ${guestUser?.lastActiveOrganizationId ?? "null"}`,
	);
	console.log(`  is a guest in the host . ${isGuest}`);
	console.log(
		`\nHost project URL ......... /app/${hostOrg.slug}/projects/${project.id}`,
	);
	console.log(
		`Guest's own workspace .... /app/${guestOrg?.slug ?? "(none)"}\n`,
	);
}

main()
	.catch((error) => {
		console.error("[guest-scenario] failed:", error);
		process.exitCode = 1;
	})
	.finally(() => db.$disconnect());
