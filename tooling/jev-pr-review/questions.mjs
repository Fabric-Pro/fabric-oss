// Yes means a violation. These four are the defect classes that recur in this
// repository's fix history and are visible in the diff that introduced them.
// Re-run the offline PR review harness before changing a question's wording or
// the default cutoff: wording can shift scores.
export const QUESTIONS = {
	tenant_scope:
		"Answer yes only if the added lines (starting with +) read or write tenant-owned records (projects, documents, agents, conversations, memories, integrations, credentials) without restricting them to the caller's organization or access: for example a lookup by id alone, a query missing organizationId, a filter written as organizationId ?? undefined so a missing organization drops the filter, rows with a scope field (SYSTEM, ORGANIZATION, USER) matched on organizationId alone, or a user arm and an organization arm combined with OR. Answer no if that scoping is present or the added lines do not touch such data.",
	authz: "Answer yes only if the added lines add or modify an API route, procedure, tool, webhook handler or background activity that acts on a project, agent or organization record, or that uses an organization, workspace or project id taken from request input, headers, tool arguments or stored configuration, without verifying the caller's current permission on that specific record (for example hasProjectAccess, canEditProject, a membership and role check, or a scope check on the loaded record). Organization membership alone does not count as verification, and background work must recheck the stored user's current membership. Answer no otherwise.",
	secrets:
		"Answer yes only if the added lines log, store, return to a client, or put into an audit record or error message a secret value such as an API key, token, password, OAuth client secret or credential, or send such a secret to a destination other than the service it belongs to; or if they put raw text from an unexpected database, provider or library error (for example error.message from a caught exception) into a reply, message, comment or record that end users or other people can read. A masked or redacted secret is not exposed, and a fixed message or a deliberate user-facing message from the code's own typed error is not raw error text. Answer no only if neither a secret nor raw error text is exposed.",
	failure_success:
		'Answer yes only if the added lines turn a failed or refused provider, tool, network or activity call into an empty list, "no results", placeholder or fallback content, or a success status, so the caller or user cannot tell that it failed; logging the error does not count as telling them. Answer no if the failure is rethrown, returned to the caller as an error or failed status, or the fallback result is explicitly marked as a fallback.',
};

export const QUESTION_DETAILS = {
	tenant_scope: {
		title: "Tenant scope",
		rule: "Restrict tenant-owned data access to the caller’s organization or authorized project.",
	},
	authz: {
		title: "Record permissions",
		rule: "Verify the caller’s current permission on the specific record at the API, tool, webhook, or activity boundary, including ids taken from input or stored configuration.",
	},
	secrets: {
		title: "Secret and error exposure",
		rule: "Keep secret values out of logs, audit records, error messages, and unintended recipients, and show users a fixed or deliberate message instead of raw error text from an unexpected failure.",
	},
	failure_success: {
		title: "Failure reported as success",
		rule: "Surface a failed or refused call to the caller as a failure, not as empty results, unmarked fallback content, or a success status.",
	},
};
