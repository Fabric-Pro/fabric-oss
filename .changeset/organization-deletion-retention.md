---
"fabric-app": patch
---

Deleting an organization is now a seven-day recoverable window rather than an irreversible click.

Before this, one button destroyed an organization and everything in it, immediately and with no
way back. The screen asked "are you sure" and nothing else — and its own copy promised a
password field that had never been rendered and could not be: magic-link and social accounts
have no password, so a password gate would have locked those owners out of deleting their own
organization.

Deletion is now a corridor with a door at both ends. Day zero deactivates: every request that
tries to resolve the organization is refused, and it leaves the workspace switcher. Nothing is
destroyed. A reminder goes out 24-48h before the end. Day seven purges for real. At any point
before that, restoring clears four columns and the organization comes back exactly as it was.

Two proofs stand in front of it, and they prove different things. Typing the organization's name
proves the person knows WHICH organization they are destroying, which is the mistake this
prevents. A single-use link emailed to the account proves it is THEM, which an unlocked laptop
otherwise does not. An authenticator or passkey challenge would be a stronger second factor and
was rejected on coverage: both refuse anyone who never enrolled one, while every account here has
a verified email.

Deactivation is enforced at tenant resolution rather than per query. That is what keeps it small:
the ~168 relations that cascade off an organization need no liveness predicate of their own,
because no session can resolve a context for a deactivated one in the first place. The check
rides the membership lookup the middleware already performs, so no org-scoped request pays a
second query. It carries its own error code, distinct from the missing-workspace refusal, so a
client can offer the owner "restore" instead of "reload".

The restore control has two homes, because where deleting leaves you depends on whether you had
another organization: a "Recently deleted" group in the switcher, and a banner on the
create-an-organization page — which is where deleting your LAST organization redirects you, and
which would otherwise be a dead end during exactly the window the feature exists to provide.

Several things ship alongside it because they became load-bearing:

- The Danger Zone menu entry was gated on owner-or-admin while the server accepted owners alone,
  so an admin could open the page, press the button and receive a hard refusal. Both the entry
  and the page are now gated the way the server actually behaves. The permission itself is
  unchanged — deletion was already owner-only and enforced.
- The auth library's own `/organization/delete` endpoint is refused. It hard-deletes inside the
  plugin and its pre-delete hook cannot refuse or alter that, so leaving it reachable would mean
  the retention window could be skipped by calling it directly. The platform-admin console now
  uses the same corridor, so an organization removed from there is exactly as recoverable.
- Subscription cancellation moved with it. That endpoint's hook cancelled the tenant's
  subscriptions before destroying the row; the purge now owns that, deliberately at purge rather
  than at deactivation, so an organization restored on day six comes back with its billing intact.
- The purge tears down what a cascade cannot reach. `deleteOrganizationCollections` has existed
  since the vector store was added, documented as "called when an organization is deleted", with
  no caller anywhere — so every organization deleted to date has orphaned its collections. It is
  called now.
- Two new audit actions, `org.restored` and `org.purged`, with the four registrations each needs.

Migrations: four nullable columns on `organization`, then the purge index alone in its own
migration because `CREATE INDEX CONCURRENTLY` cannot share a transaction. No backfill — every
existing row is live by definition.

No feature flag. Flag-off would restore today's immediate irreversible delete, so the flag would
protect nothing, and a partly-working restore is no worse than no restore. The corridor and the
purge ship in one release instead, which is the stronger guarantee: a switch left on with no
purge behind it strands organizations silently.
