---
"fabric-app": patch
---

Add a revocation pass for personal API keys issued before they resolved into an organization

A `fab_` key used to run with no organization at all. It now resolves through the shared helper, so it reaches everything its owner may reach in the organization it lands in — the largest tenancy class filters that context by organization alone. That is not an escalation beyond the owner's own rights, and it is a change in what the key's disclosure would cost, decided for a credential its holder issued under narrower expectations.

The ruling was to revoke rather than to bind or to accept. `pnpm --filter @repo/database revoke:pre-org-keys -- --before <ISO timestamp>` deactivates keys created before the cutover; owners issue new ones knowing the reach.

Dry run by default — it reports what it would revoke and changes nothing until `--apply` is passed. The cutoff is required rather than inferred, because only the person running it knows when the resolution change reached the deployment, and guessing would revoke too much or too little in silence.

Revocation is the deactivation the verifier already checks, not a delete: the rows stay, so usage counts and the audit trail survive and the revocation can be answered for later.
