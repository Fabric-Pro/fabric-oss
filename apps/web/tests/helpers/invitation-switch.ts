/**
 * Seeds for the "switch account on invite" E2E. The browser starts
 * authenticated as Account A (via storageState) and opens an invite addressed
 * to Account B. Wiring the seed rows is deferred (see project-invitation.ts);
 * specs skip when the env vars are unset so the suite stays green locally.
 *
 * Required env vars (CI only):
 * - E2E_SWITCH_STORAGE_STATE   — path to a storageState JSON authenticated as A
 * - E2E_SWITCH_ORG_INVITATION_ID    — org invitation addressed to B
 * - E2E_SWITCH_PROJECT_INVITATION_ID — project invitation addressed to B
 * - E2E_SWITCH_INVITED_EMAIL   — B's email
 */
export interface SwitchSeed {
	storageState: string;
	orgInvitationId: string;
	projectInvitationId: string;
	invitedEmail: string;
}

export function readSwitchSeedFromEnv(): SwitchSeed | null {
	const storageState = process.env.E2E_SWITCH_STORAGE_STATE;
	const orgInvitationId = process.env.E2E_SWITCH_ORG_INVITATION_ID;
	const projectInvitationId = process.env.E2E_SWITCH_PROJECT_INVITATION_ID;
	const invitedEmail = process.env.E2E_SWITCH_INVITED_EMAIL;
	if (
		!storageState ||
		!orgInvitationId ||
		!projectInvitationId ||
		!invitedEmail
	) {
		return null;
	}
	return { storageState, orgInvitationId, projectInvitationId, invitedEmail };
}
