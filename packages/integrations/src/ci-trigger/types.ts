/**
 * Shared vocabulary for starting a run in a customer's EXISTING CI pipeline.
 *
 * Fabric never writes CI configuration — triggering is the whole scope. A
 * provider that cannot be triggered with the credential we hold is reported as a
 * specific, actionable rejection rather than a generic failure, because "we could
 * not start your pipeline" is useless to the person who has to fix it.
 */

/** Code-repository providers whose CI Fabric can start a run in. */
export type CiTriggerProvider = "GITHUB" | "GITLAB" | "AZURE_DEVOPS";

/**
 * Why a trigger could not start, in the vocabulary the UI explains to a user.
 * Each value maps to a different remedy, which is the only reason to distinguish
 * them: NOT_DISPATCHABLE is a change to their workflow file, INSUFFICIENT_SCOPE
 * is a change to the connected token, NOT_FOUND is a wrong ref or definition.
 */
export type CiTriggerFailure =
	/** GitHub only: the workflow file declares no `workflow_dispatch:` trigger. */
	| "NOT_DISPATCHABLE"
	/**
	 * The connected credential cannot start a run. Covers BOTH a valid token
	 * missing a scope and one the provider rejected outright (revoked, expired) —
	 * they share a code because they share a remedy, reconnecting the repository,
	 * and this union exists to distinguish remedies rather than causes. The
	 * `message` still tells the two apart, because "add a scope" and "your token
	 * is gone" send someone to different parts of the same screen.
	 */
	| "INSUFFICIENT_SCOPE"
	/** The workflow / build definition / ref does not exist (or is invisible). */
	| "NOT_FOUND"
	/** The provider is throttling us; the same call may succeed later. */
	| "RATE_LIMITED"
	/** Anything else the provider reported, passed through with its own message. */
	| "PROVIDER_ERROR";

export interface CiTriggerSuccess {
	ok: true;
	/**
	 * Provider run id when the API returns one. GitHub's dispatch endpoint
	 * answers `204 No Content` and deliberately returns no id, so this is null
	 * there — the run still starts, it just cannot be named yet.
	 */
	runId: string | null;
	/** A page the user can open to watch the run, when one can be derived. */
	runUrl: string | null;
}

export interface CiTriggerRejection {
	ok: false;
	failure: CiTriggerFailure;
	/**
	 * User-facing and actionable: it names what is wrong and what would fix it.
	 * Never contains the credential — these strings are rendered in the UI and
	 * written to logs.
	 */
	message: string;
}

export type CiTriggerResult = CiTriggerSuccess | CiTriggerRejection;

/**
 * A CI definition a user can choose to run. GitHub calls these workflows and
 * Azure DevOps calls them build definitions; GitLab has no equivalent (a
 * pipeline is created for a ref, from the `.gitlab-ci.yml` on that ref), so a
 * GitLab source offers none and is triggered by ref alone.
 */
export interface TriggerablePipeline {
	/** Provider-native id, passed straight back to the trigger call. */
	id: string;
	name: string;
	/** The workflow / definition file path, when the provider exposes one. */
	path: string | null;
	/** The provider's page for this definition, when it exposes one. */
	url: string | null;
}
