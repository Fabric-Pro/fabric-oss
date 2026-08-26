/**
 * Helpers for end-to-end coverage of the project-invitation modal.
 *
 * Seeding lives outside Playwright by design: invitation rows belong to a
 * tenant org and require an inviter (project owner) and a project to exist
 * first. The recommended approach is to call the same `inviteToProject`
 * oRPC procedure used in production, authenticated as a seeded org-owner
 * test user. Wiring that to a fixture is intentionally deferred — the
 * scaffolding below is the behaviour-level contract these specs assert.
 *
 * Required environment variables (see `apps/web/tests/auth.setup.ts` for
 * the existing pattern):
 *
 * - `E2E_USER_EMAIL` / `E2E_USER_PASSWORD` — seeded inviter (org owner)
 * - `E2E_PROJECT_INVITATION_ID_NEW_USER` — invitation for an unseen email
 * - `E2E_PROJECT_INVITATION_EMAIL_NEW_USER` — that invitation's email
 * - `E2E_PROJECT_INVITATION_ID_RETURNING_USER` — invitation for an
 *   existing verified user
 *
 * For local runs without the env vars set, the specs skip via
 * `test.skip(...)` so the suite stays green.
 */

import type { Page } from "@playwright/test";

export interface InvitationSeed {
	invitationId: string;
	email: string;
}

export function readNewUserSeedFromEnv(): InvitationSeed | null {
	const invitationId = process.env.E2E_PROJECT_INVITATION_ID_NEW_USER;
	const email = process.env.E2E_PROJECT_INVITATION_EMAIL_NEW_USER;
	if (!invitationId || !email) {
		return null;
	}
	return { invitationId, email };
}

export function readReturningUserSeedFromEnv(): InvitationSeed | null {
	const invitationId = process.env.E2E_PROJECT_INVITATION_ID_RETURNING_USER;
	if (!invitationId) {
		return null;
	}
	return {
		invitationId,
		email: process.env.E2E_USER_EMAIL ?? "e2e-user@example.com",
	};
}

export async function gotoInvitation(
	page: Page,
	seed: InvitationSeed,
): Promise<void> {
	await page.goto(`/project-invitation/${seed.invitationId}`);
}
