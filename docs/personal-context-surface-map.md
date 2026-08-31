# Personal context surface map

What exists only in the personal workspace context, what must be built at organization level before it can be removed, and what moving the data would have cost had it been moved — the feature audit Fizzy #1875 requires, revised after the 2026-08-25 ruling to drop the data rather than migrate it.

- **Audience**: The product owner approving dispositions, and the engineers who will implement the elimination across several later changes
- **Owner**: Fabric platform

| | |
|---|---|
| **Classification** | **Internal, and now publishable on its own terms.** The document was held back because it named a cross-tenant isolation defect that was open when it was written. That defect is repaired in the same change that carries this document — a caller-supplied organization is now honoured only after membership is confirmed — so the trigger below is met. The mechanism that previously enforced the hold, a publication classification and an explicit deletion array, was itself removed from this repository during the sanitisation that produced it; nothing here enforces a hold any more, and nothing here needs to. |
| **Status** | **Approved 2026-08-27; executed 2026-08-28; data side closed as not applicable 2026-08-31.** Every entry in **Decisions requested** carries an approved or settled disposition. The two consequences recorded under PO-11 no longer need an owner: personal API keys are decided (revoke rather than re-issue, if a production deployment ever holds any), and nobody is notified because there is no production population to notify. The drop, the backfill and the production inventory are skipped for the same reason — see **The data side closes as not applicable** in the remainder plan, which also records what would reopen them. |
| **Publication trigger** | Met. The isolation defect recorded in the resolution section is repaired in this change. (The other protocol finding there was a resolution default rather than a defect and never gated publication.) |

## What has since been removed

This document is an AUDIT — a record of what existed and the evidence behind
each disposition. It is deliberately not rewritten as the tree changes, because
its value is that it says what was true when the decisions were made. Read this
section first, then the audit as history.

Executed on `feature/1875-org-only-context`, verified against a running
deployment rather than by reading:

| Was | Is |
|---|---|
| Seventeen route trees under the account group, plus `agents` and `frames` outside it | One redirect per tree into the caller's organization; `/app/test` gone |
| Twenty-one personal settings routes | One catch-all, mapping the four account-global pages to `settings/account/*` |
| A guest shown a personal workspace, and the host org named in twenty-two of twenty-three breadcrumb trails | A guest rooted in THEIR OWN organization; the host named nowhere in their chrome |
| Five interface strings naming personal tenancy | Gone. The eight naming a credential class stay, and say why |
| Twenty-nine permission checks that could not evaluate | All evaluate, against the organization their handler acts on |
| Accounts without an organization | Every account gets one, at signup and as a sign-in backfill |

What is NOT done: the drop itself. The inventory and the two-phase job exist and
have been exercised end-to-end against a local database; neither has been run
anywhere real. That is the last unit, and its dry run is to be read first.

Two corrections to the audit's own conclusions, both established by running the
work rather than by re-reading it:

- **PO-6 is reversed.** It approved showing a project-only guest the host
  organization, weighed when a guest had no organization of their own. FR1a
  removed that premise, so the guest is shown theirs and the host stays unnamed
  — the guarantee four separate places in the code were written to protect.
- **The audit's route count was low.** `/app/agents` and `/app/frames` are
  personal-rooted trees outside the account group, so a count of that group's
  directories never reached them.

---

## Direction, as of 2026-08-25

**Ruled at the 2026-08-25 stand-up: personal workspace data is dropped, not migrated.** The team's position is that no active personal workspace usage exists on the platform, and a further technical verification pass before the drop was explicitly decided against. Both are recorded decisions with named owners.

So the work is **feature parity, not data movement**. Every setting and capability that exists only in personal context must exist at organization level; the rows behind them are removed rather than moved. Said plainly: a user who had projects, documents, chats or files in a personal workspace loses them. What is preserved is the capability, not the content.

The migration job itself is still required — the ticket keeps it prospectively, so that anything later found to be active has a path — but its data branch is expected to be a no-op.

This reframes the document rather than invalidating it. What was written to price a migration now reads as the evidence for declining one — and the findings below are unusually strong support for that call: migrating would have made billing records invisible, required suspending the audit log's tamper-evidence trigger, exposed eighty-six models' worth of previously-private data on first invitation, promised a restore capability that has never been built, and stranded every file and embedding regardless.

**What actually has to be built** is the `build equivalent` set. The ticket makes this explicit: every personal-level setting and feature must reach parity at organization level *regardless of whether the underlying data is dropped*. That requirement, not the migration job, is what this document now exists to satisfy — and the ticket names the disposition list below as one of only two things still blocking the work.

---

## How to read this

**Evidence marker.** Every enumerated row carries one:

| Marker | Means |
|---|---|
| `[source]` | Verified by reading the named file in this repository |
| `[deployment]` | Observed on a running non-production deployment, 2026-08-25 |
| `[inferred]` | Neither — reasoning from surrounding evidence, and flagged as such |

A row with no marker is a defect in this document, not a default.

**Two terms, deliberately distinct.** *Personal context* is the tenancy encoding — a null organization on a row, and the branch every filter takes because of it. *Personal workspace* is what a user is shown: the routes rooted without an organization slug, the switcher entry, the settings tree. They usually coincide. The project-guest finding is where they come apart, and that is the point of keeping them separate.

**Derivation.** Every enumeration says how its population was produced, and the rows equal the stated count. Where that fits one command, the command is printed and reproduces the count — re-run it rather than trusting the number. Where the population came from diffing two listings or reading a file section, the method is described instead.

This is the only property of the document that can detect a *missing row*. It cannot detect a **missing source population** — a whole class of state nothing here derives from. Every derivation below starts from the relational schema or the route tree, so a store that encodes tenancy some other way is invisible to all of them. Two such stores were found only by adversarial review, after the relational enumeration was complete; they are in *State that is not a database row*, along with what remains unexamined.

Derivations are also the property most likely to go stale, because this is a snapshot of a tree that moves.

**Disposition.** Every item carries exactly one of five labels and a one-line reason. The reason matters more than the label: it is what a reviewer disagrees with.

| Label | Means | Who decides |
|---|---|---|
| `no action` | Already scoped per user, not per context — survives elimination untouched | Engineering |
| `retarget` | A **code path** that resolves to personal must resolve to an organization instead. Behaviour moves; no rows do | Engineering |
| `drop` | **Data** that is removed rather than moved, per the 2026-08-25 ruling. Irreversible; no archive | Decided |
| `build equivalent` | No organization counterpart; one would have to be built. **This is the live work** | Product owner |
| `remove` | A **surface** — route, affordance, flag, string — that ceases to exist. About reachability, not storage | Product owner |
| `repair` | Wrong today, independent of the elimination; own remediation timeline | Engineering, tracked separately |

The split between `retarget` and `drop` is the whole shape of the change. A resolver that hands back a null organization is code and must be fixed; a row carrying a null organization is data and is removed. Neither is a migration.

Every engineering-settled disposition (`no action`, `retarget`) also carries a **falsifier**: the one observation that would move it to the product owner. The label decides whether an item is ever read by the approver, so the routing has to be reviewable too — not only the disposition.

**Decision lifecycle.** Every entry in *Decisions requested* carries a decision field that starts at `proposed`. Sign-off edits it in place to `approved` or `overturned — <ruling>` with the date. The **Status** row above flips to Approved only when no entry remains `proposed`. An unmarked entry means the session has not happened — it does not mean assent.

**Disclosure boundary.** For a defect still open at the time of writing, this document records the entry-point class, the disposition, and the sentence needed to price it. It records neither the file nor reproduction mechanics. A surface map that explains how to exploit an open defect is a recipe.

## Headline findings

Five findings contradict the ticket's own text or its assumptions. They are here rather than in a table because each one changes what the migration is.

**1. The ticket's worked example needs no migration; two tables it does not mention do.** Fizzy #1875 names notification settings as its confirmed instance of a personal-context feature to migrate. Both notification preference tables are keyed per user with an organization column that no caller ever populates — they are account-global already and survive untouched. Meanwhile `UserOrchestratorPreferences` and `UserChatAgentSelection` use the same empty-string encoding and *do* mean personal, and neither appears in the ticket. The estimate of "what is personal" appears to have been formed from route shape rather than data shape. `[source]`

**2. A naive migration makes billing records invisible.** The `STRICT_ISOLATION` class filters organization context on `{ organizationId, userId: null }`. A migrated row carries both a user and an organization, so it matches the organization branch not at all and the personal branch no longer runs. The four models in that class include `Purchase` and `AiCreditAccount`. Migration for this class is not "set the organization" — the user column has to be cleared in the same statement, which destroys attribution unless something else carries it. `[source]`

**3. The audit trail cannot be migrated without repeating a one-off authorisation.** `audit_log` is append-only under a row-level trigger that binds even the table owner. The trigger permits exactly one mutation to an existing row — a tenant key moving *to* null. This epic needs the opposite direction. The one precedent disabled the trigger inside a single transaction, was authorised as a one-off by the product owner, deliberately left personal-context rows alone, and recorded that a standing bypass was refused on purpose. `[source]`

**4. Eighty-six models lose their per-user predicate, and the exposure is deferred rather than avoided.** The `USER_OWNED` class filters organization context on the organization alone. Under the ticket's mapping — a new, separate, private organization — nothing is exposed at cut-over, because the destination has one member. The exposure is structural, not gated: it activates on the first invitation, with no further migration and no second decision point. The class includes the audit trail, meeting transcripts, AI usage, and data-connection metadata. `[source]`

**5. "Restorable" is a new capability, not a reuse.** The ticket requires a restorable archive held ninety days. A ninety-day retention precedent exists here, with a grace period so a mistyped window stays recoverable — and the codebase states in three separate places that this precedent ends in irreversible deletion with no restore surface. Nothing in the record demonstrates that a restore of this database has ever been performed. `[source]`

**6. The first pass enumerated only relational state, and that was not enough.** Tenancy is also encoded in object-storage keys — where a personal file is stored under the user's prefix and the read guard rejects a key whose prefix no longer matches the caller's tenant — and in the vector store, where personal embeddings live in a shared collection while each organization gets a physically separate one. Migrating rows without re-keying objects strands the files; migrating rows without moving embeddings strands retrieval. Neither was reachable by any derivation in this document, and both were found by adversarial review rather than by the method. What that says about the method is recorded with them. `[source]`

One further contradiction sits below the level of a finding but changes scope: **the ticket's acceptance criteria do not reach every entry point it affects.** AC12 is UI-only; AC3 covers creation; AC10 and AC11 cover protocol context resolution. The versioned REST query flag and the command-line context selector are governed by none of them, and both are client-facing tenancy selectors on public surfaces.

---

## Decisions requested

*This section is readable on its own. Every entry links to the evidence that produced it, but you do not need to read the evidence to act.*

**Most of this is now answered.** The drop ruling of 2026-08-25 resolves five of the entries below outright — they are kept, marked **Answered**, because they record why the ruling is sound and what a reversal would cost. **Four remain live**, and they are all the same shape: functionality that exists only in personal context and has nowhere to go.

| | Entry | State |
|---|---|---|
| PO-1 | Destination organization | **Answered** — no migration, so no destination. Still relevant only for *new* signups |
| PO-2 | Account security settings | **Recommended** — account section inside organization settings |
| PO-3 | User-scoped billing and usage | **Recommended** — drop, with provider-side cancellation ordered before row deletion |
| PO-4 | Scoped prompts and agents | **Answered** — rows stay put; nothing publishes |
| PO-5 | 86 models losing per-user filter | **Answered** — nothing migrates, nothing is exposed |
| PO-6 | Project-guest presentation | **Recommended** — accept the disclosure |
| PO-7 | Audit log and the tamper trigger | **Answered** — no backfill, trigger untouched |
| PO-8 | Restorable 90-day archive | **Answered** — nothing to archive |
| PO-9 | REST flag and CLI selector | **Recommended** — no-ops that resolve to an organization |
| PO-10 | Four surfaces with no counterpart | **Recommended** — build routes for two; the other two resolve elsewhere |
| PO-11 | The drop, and what it removes | **Settled 2026-08-25** — recorded, two consequences still need an owner |

One entry is **new**: PO-11 records the drop decision itself, what this audit does and does not know about what it removes, and two consequences that survive it — personal API keys resolving to nothing, and nobody telling affected users.

**To rule on an entry, edit its `Decision:` field in place** — `approved`, or `overturned — <your ruling>` — and date it. The document's status stays *Proposed* until no entry reads `proposed`.

Fizzy #1875 blocks migration design until **every** personal-context-exclusive item carries an approved disposition — not only the subset routed here. So this section opens with the engineering-settled remainder, for block approval, and then asks for the nine decisions engineering cannot make.

### Block approval — the engineering-settled remainder

Engineering assigned these itself. Approving them as a block clears the ticket's blocker for everything not listed individually below. Any one of them can be pulled up into the decision list instead — the falsifier column says what would justify that.

| Disposition | Items | What it means | The falsifier that would move it to you |
|---|---:|---|---|
| `no action` | 17 user-scoped models, 7 organization-only models, 13 per-user-within-org models, both notification preference tables, 19 paired settings routes, the whole main navigation | Nothing to migrate; unaffected by the change | A model turns out to be read through a tenant-filtered join rather than a column, or a caller is found populating an inert column |
| `retarget` | The three resolvers, the derived writers, webhook tenancy derivation, the generated policy templates, both protocol entry points |
| `drop` | The 78 residual models, two empty-string preference tables, object-storage keys, vector-store collections, and every personal row in the tenancy classes | Moves under a defined mapping; no product judgement involved | A uniqueness collision surfaces, or a relation trace shows a record splitting from its parent |
| `remove` | The versioned REST query flag, the command-line context selector, the context switcher and its three render sites, a stale redirect route, a developer test harness, two duplicate agent routes | Ceases to exist with the tenancy it selects between | An external consumer is confirmed to depend on the surface |
| `repair` | The residual permission bypass, the account-settings link gap, one broken agent route, the interface strings and catalog literals | Wrong today, independent of this epic; fixed on its own timeline | — |

**Decision:** `approved 2026-08-27` — approve as a block, or name any item to pull into the list below.

This entry carries its own decision field because the engineering-settled set is the majority of enumerated items. Without it the header could read Approved while nothing recorded that they were.

---

### PO-1 · Destination organization, per user category

> **Answered 2026-08-26 — no migration, so no destination.** Kept because it still governs which organization a *new* signup lands in, and because a reversal would put every consequence below back on the table.

**Decision:** `approved 2026-08-27` — the ticket's mapping stands, and the naming is settled with it: the auto-created organization is named **`[Name]'s workspace`**, for every signup path including the marketing site. The feature logged the marketing-site variant as unreconciled with the platform-wide convention; this ruling reconciles it in favour of the platform convention rather than keeping a second name alive for one funnel.

Every `migrate` disposition in this document rests on this. The ticket specifies a **new, separate, private organization per user**, not a merge into one they already belong to. That choice is what keeps the visibility consequence at zero on day one.

| Category | Proposed destination | Role there | What others see | Population |
|---|---|---|---|---|
| No existing membership | New private organization | Owner | Nobody — one member | Not instrumented |
| Already belongs to an organization | A **second**, separate private organization | Owner of the new one; existing roles unchanged | Nobody in the new one; existing organizations see nothing new | Not instrumented |
| Owner of an existing organization | Same as above | Owner of both | Same as above | Not instrumented |
| Project-only guest | New private organization | Owner | Nobody | Not instrumented |

**If you decide otherwise:** merging single-organization users into their existing organization is defensible and immediately activates PO-4 and PO-5 against a populated member list, on day one rather than on first invitation.

**Note:** nothing creates an organization at signup today, and the existing creation path is browser-driven. The provisioning mechanism is net-new work in a later change.

---

### PO-2 · Account security settings have no organization counterpart

**Decision:** `approved 2026-08-27` — engineering's recommendation, confirmed. **Give account settings their own section inside organization settings.**

This follows FR5 directly — it requires personal routes to be *redirected to the user's org workspace* rather than merely deleted. The data is already account-global, so nothing moves; what is needed is a route and a menu entry. It also closes a defect that exists today, before any elimination: from organization context there is no link to account settings at all.

Password, passkeys, two-factor, connected accounts, and active sessions live at a route that exists only in the personal tree. The underlying data is account-global and unaffected. The problem is navigational: **from organization context there is today no link to account settings at all** — not in the sidebar, not in the user menu. The context switcher is the only way in, and it is being removed.

**Population:** every user. **If you decide otherwise:** `remove` is not available — these are credential surfaces. Doing nothing means users reach their own security settings only by typing the URL.

---

### PO-3 · User-scoped billing, subscriptions, credit accounts, and usage limits

**Decision:** `approved 2026-08-27` — engineering's recommendation, confirmed. **Drop these with everything else.** `drop`

The ticket touches billing only at the front door — removing the trial credit and card collection on signup. It says nothing about existing user-scoped records, so this closes the gap rather than contradicting anything.

**One execution consequence, not a reason to revisit.** A purchase row carries the payment provider's own `customerId` and `subscriptionId`; the latter is unique and indexed, which makes it the join key to the provider. Deleting the row removes *our record* of a subscription — it does not cancel the subscription. If any personal-context purchase is still live at the provider, dropping the row severs the only local link while billing continues. **The drop job must cancel at the provider before it deletes the row**, or the order has to be reversed deliberately and recorded.

These resolve independently of any organization: a plan is derived from the purchase record alone. A personal-context paid subscription is a real, resolvable state today. Two of the affected models sit in the class described in finding 2 — a migration that sets the organization without clearing the user column makes them invisible; one that clears it destroys attribution.

**Population:** unknown — no count was taken, and it should be before this is decided. **If you decide otherwise:** leaving them user-scoped keeps a second billing dimension alive after the tenancy is unified, which is the duplicate maintenance the ticket set out to remove.

---

### PO-4 · Scoped prompts, agents, and report templates cannot migrate neutrally

> **Answered 2026-08-26 — moot.** The rows stay where they are, so nothing publishes and nothing vanishes. Kept as the cost of a reversal.

**Decision:** `approved 2026-08-27` — publish scoped rows to the whole organization, or fund a per-user predicate that does not exist yet.

Four models filter on a scope enum rather than on tenancy alone. A personal row carries user scope, which the organization branch does not select. Leave the scope and **the row disappears**; change it to organization scope and **the row publishes to every member**. The filter offers no third option.

**Population:** every user with a personal prompt, agent, or report template. **If you want author-private rows inside an organization**, that needs a per-user predicate this class does not have — `build equivalent`, not `migrate`.

---

### PO-5 · Eighty-six models lose their per-user predicate

> **Answered 2026-08-26 — moot.** Nothing migrates, so nothing becomes readable to anyone. This was the single strongest argument against migrating and is kept as such.

**Decision:** `approved 2026-08-27` — accept the deferred exposure, or reclassify.

Under PO-1's mapping nothing is exposed at cut-over. But the exposure is structural: the moment a second member joins a destination organization, every row in this class becomes readable to them — audit trail, meeting transcripts, AI usage, data-connection metadata included. No further migration and no second approval stands between the invitation and the exposure.

**Population:** every migrated user, on first invitation. **If you decide otherwise:** reclassifying specific tables to keep a per-user predicate is `build equivalent` and changes the filter for existing organization users too.

---

### PO-6 · The project-guest presentation disappears — and the ticket does not mention it

**Decision:** `approved 2026-08-27` — engineering's recommendation, confirmed. **Accept the disclosure — a project guest sees the organization that owns the project.**

AC12 forbids any element that provides access to a personal workspace, and building a third neutral presentation is work the ticket does not fund. A guest already knows they were invited into someone's project; naming the organization is a change in what is shown, not a change in what they can reach. Recorded as a disclosure decision rather than a cleanup, because that is what it is.

Users whose only access is a shared project are **deliberately** shown the personal workspace inside the host organization, so the host's identity is never disclosed to them. This is documented as intentional in four independent places, and the organization settings layout actively redirects them out. Eliminating the personal workspace removes their entire presentation surface, and there is no fallback.

**Population:** every project-only guest. **If you decide otherwise:** accepting that guests see the host organization's identity collapses this to a plain migration with no follow-on work — but it is a disclosure change, not a cleanup.

---

### PO-7 · The audit trail: split, or repeat the one-off authorisation

> **Answered 2026-08-26 — moot.** No backfill, so the tamper-evidence trigger is never suspended and no fresh authorisation is needed.

**Decision:** `approved 2026-08-27` — needs your ruling, and it is personally yours: the precedent was authorised by the product owner.

Either pre-cutover audit rows stay behind — organization admins see nothing a migrated user did before the change — or they are backfilled by suspending the tamper-evidence trigger, as was done once before under a one-off authorisation that explicitly refused a standing bypass.

**Coupling:** this cannot be approved independently of the personal audit-log route's disposition. If that route is removed *and* the rows are left behind, they become unreachable from any surface — the exact defect the earlier backfill was written to repair.

**Population:** every migrated user with audit history.

---

### PO-8 · "Restorable archive" — confirm what is being promised

> **Answered 2026-08-26 — moot.** Nothing is archived, so no restore capability has to be built. FR8 is superseded by the ruling.

**Decision:** `approved 2026-08-27` — confirm the requirement, or relax it.

FR8 requires a restorable ninety-day archive. The ninety-day number has a precedent here. Restorability does not: the existing precedent ends in irreversible deletion with no restore surface, and no restore of this database has ever been demonstrated. The archive would also be a new data category, which carries its own obligation to declare a retention period, a disposal path, and — because it holds rows that were private to one user — **a reader set**. That reader set is your input, not an implementation detail: "the originating user only", "organization owners", and "platform operators" are three different approvals.

**Population:** every migrated user. **If you decide otherwise:** relaxing "restorable" to "retained" removes a capability that would have to be built and demonstrated.

---

### PO-9 · Two surfaces are governed by no acceptance criterion

**Decision:** `approved 2026-08-27` — engineering's recommendation, confirmed. **Both become no-ops that resolve to an organization**, under the same rule FR4 sets for the protocol server: a single organization resolves to itself, several resolve to the last active one.

This keeps existing callers working rather than breaking them, and it needs no new acceptance criterion — it reuses the one the ticket already defines. An installed command-line client keeps functioning until its user upgrades, which removing the flag outright would not allow.

The versioned REST query flag and the command-line context selector are both client-facing tenancy selectors. AC12 is UI-only and does not reach them; AC3 reaches only the subset that creates records; AC10 and AC11 cover protocol resolution. Removing them is a breaking change on public surfaces that no criterion currently governs — and an installed command-line client keeps sending the removed flag until its user upgrades.

**Population:** unknown — external API and CLI consumers are not instrumented.

---

### PO-10 · Four surfaces have no organization equivalent and no owner

**Decision:** `approved 2026-08-27` — engineering's recommendation, confirmed. **Build organization routes for automation templates and the task-planner agent.**

FR3b requires parity for every personal-level feature *regardless of whether the underlying data is dropped*, and automation templates are presented as a live feature — they own a registered page tour. Dropping them would be losing value silently, which the ticket forbids. The vector store and the guest presentation are covered by the drop ruling and PO-6 respectively.

`build equivalent` is a product-owner label by definition, and four items carry it outside the entries above. None has an organization-rooted counterpart today, and the ticket's acceptance criteria verify only the migrate and remove branches — so an item approved here and not given a ticket is owned by nobody.

| Item | What has no counterpart | If not funded |
|---|---|---|
| Automation templates | **Built 2026-08-27** — the three routes now exist organization-rooted, and the list, card and editor derive every navigation from the active base path instead of the personal one | The feature becomes unreachable when the personal route tree goes |
| The task-planner agent | **Built 2026-08-27** — the workspace moved into the agents module and both trees mount it; agent-register was repaired alongside it | Same |
| The vector store | Personal embeddings live in a shared collection; each organization gets a physically separate one. There is no operation that moves a user between them | Migrated users get retrieval from neither collection |
| The project-guest presentation | Covered separately as PO-6 — repeated here only so the label's population is complete | See PO-6 |

**Population:** every user for the first two; every user with embedded content for the third. **Note on cost:** the vector-store item is the only entry in this document whose price is not paid in engineering time alone — re-embedding has a direct monetary cost proportional to stored content.

---

### PO-11 · The drop, and what is known about what it removes

**Decision:** `settled 2026-08-25` — recorded here, not reopened.

Two decisions were taken together at the stand-up and both have named owners:

- Personal workspace data is **dropped**, not migrated and not archived. The ticket's ninety-day restorable archive does not apply to it.
- **No technical verification pass is required before the drop executes.** The team's assessment that no active usage exists was accepted as sufficient.

What this audit can and cannot say about that:

| | |
|---|---|
| **Established** | Personal scope carries purchases, credit accounts, AI usage limits, the audit trail, personal API keys, projects, documents, chats, and the objects and embeddings behind them. These are categories the schema defines and the code reaches — not hypotheses. |
| **Not established** | Whether any rows exist in them. No population was counted anywhere in this document; every decision entry records `population not instrumented`. |

That gap is stated rather than argued. Counting is a query per model, and as of 2026-08-27 it is no longer a thing someone has to write: `pnpm --filter @repo/database count:personal-context` reports the rows per model, the users with no organization, and the personal API keys owned by them — read-only, against whichever database the environment points at, with `--json` for quoting a figure into a decision without retyping it.

The decision not to run one before the drop stands, and is recorded above with its owner. What has changed is that the three numbers the elimination actually turns on — how much is there, how many people have nowhere to be moved to, and how many credentials resolve to nothing afterwards — can be had in one command rather than estimated.

**Two consequences survive the drop and need an owner regardless:**

- **Personal API keys have no organization column at all.** Written when dropping the context would have left them resolving to nothing; that half is closed as of 2026-08-27 — both protocol servers and the versioned REST API now resolve a key-authenticated caller through the shared helper, so a `fab_` key lands in an organization rather than nowhere.

  What the column's absence still means is **consent**, not resolution. A key issued to reach one person's own rows now reaches everything its owner may reach in the organization it resolves into — the largest tenancy class filters that context by organization alone. It is not an escalation beyond the owner's own rights, and it is a change in what the credential's disclosure would cost. Binding each key to an organization, revoking those issued earlier, or accepting the widened scope in writing are all defensible; proceeding without choosing is not, and it is a stop condition on the change that made it true.
- **Purchase rows point at a payment provider.** They carry the provider's customer and subscription identifiers, so deleting a row deletes our record and nothing else. Cancellation is a separate call and has to happen first.
- **Nobody is told.** Users lose access to personal projects, documents, chats and files. The ticket's communications note covers migrated users; there is no note for dropped ones.

---

### Separate track, not part of this sign-off

One isolation defect recorded in the resolution section is wrong **today**, independent of this epic — it would still need fixing if #1875 were cancelled. It carries the `repair` disposition and should be approved onto its own remediation timeline rather than inheriting this epic's schedule. Pricing an open security item inside a product migration buries it behind that migration's dates.

---

## The inverse list — what is identical in both contexts

The ticket's risk is silent loss. Demonstrating that requires enumerating what is *not* lost, not only what is. This section exists because `docs/solutions/security-issues/a-trust-boundary-has-more-than-one-axis.md` records that naming one hole directs attention at it and away from everything else — the brief becomes the boundary of the audit.

| What | Why it is unaffected | Evidence |
|---|---|---|
| **The entire main navigation** — 13 linked destinations | The navigation array contains no context branch at all. Every destination is built from a single base-path variable, so parity holds by construction, not by configuration. Verified independently on a running deployment. | `[source]` `[deployment]` |
| **19 of 24 settings routes** | Paired slug-for-slug across both trees. Two share a slug while being different features (account profile versus organization profile; delete account versus delete organization), but both sides exist. | `[source]` |
| **17 models with no tenancy dimension** | Credentials, sessions, passkeys, two-factor enrolment, personal API keys, per-user model and provider preferences, workspace role rows. No organization column to migrate, no filter branch to remove. | `[source]` |
| **Both notification preference tables** | Keyed per user, organization column inert, no caller populates it. Account-global before the migration and after it. | `[source]` |
| **The 13 `PER_USER_ORG` models** | Their organization branch keeps the per-user predicate, so a migrated row stays private to its owner. This is the class the other 86 are not. | `[source]` |
| **The 7 `ORG_ONLY` models** | Personal context already cannot reach them — the filter returns a sentinel matching nothing. No rows exist to move. | `[source]` |
| **Project ownership** | Derived from the project row rather than from tenancy, so the owner short-circuit in the permission layer is unaffected. | `[source]` |
| **The no-session-fallback guarantee** | The rule that an explicit null never falls back to the session's active organization is an anti-leak control independent of which tenancies exist. It survives the change and must not be retired alongside the personal branch. | `[source]` |

Every item the evidence sections assign `no action` **on the personal-exclusive surface** appears here. Organization-only surfaces also carry `no action` — they are unaffected by definition — and are not repeated here; nor are the invariant-register rows, which are engineering follow-on rather than dispositions.

---

## Settings, routes, and interface surfaces

*Scope: everything reachable through the app shell — the settings trees, the full application route tree, the sidebar navigation, and the non-route affordances.*

### S1 Two enumerations of settings that disagree

**Directory population.** `ls -1 "apps/web/app/(saas)/app/(account)/settings" | grep -v '\.tsx$' | wc -l` → **22**; the same against `apps/web/app/(saas)/app/(organizations)/[organizationSlug]/settings` → **21**. `[source]`

**What the layouts render.** The settings sidebar is not derived from the tree — each side hand-writes a menu array. Both render **17** entries, and position for position they are the same list with two items swapped: personal has **Security** and **Notifications** where organization has **Members** and **User Activity**. `[source]`

Billing renders on both sides in code, gated by two separate configuration keys that are off by default. On a running deployment neither rendered, so the two menus showed 16 and 15 entries. **Reachability of billing is deployment-dependent, not context-dependent** — marked **[config: `enableBilling`, both user and organization keys]**. `[deployment]`

**The disagreement is itself a finding.** 22 directories against 17 entries on one side, 21 against 17 on the other: **nine route directories render no settings-menu entry, and eight of the nine have no inbound link anywhere in the web app.** The exception is `settings/integrations`, which is linked from the main sidebar instead — which is exactly why an inventory built from the settings menu would wrongly read it as dead. `[source]` A route that exists but is unreachable is a different object from a live one — it cannot have accumulated user habit, it may have accumulated data, and "migrate it" and "delete it" are both defensible in a way they are not for a live page.

| Route | Context | What it is | Disposition + reason |
|---|---|---|---|
| `settings/ai-gateway` | personal only | Redirect stub to the providers page; no organization twin | **Removed 2026-08-27** — was `remove`. A stale personal-only redirect with no twin and no inbound link; migrating it would have meant inventing an organization route that never existed. Its stale entry in the settings breadcrumb title map is a label lookup, not a link, and outlives the route harmlessly |
| `settings/firecrawl` | both | Redirect stub, symmetric | `no action` — context-symmetric, so it carries no personal weight; it catches stale bookmarks. *Falsifier:* traffic data showing zero hits makes it `remove` |
| `settings/data-connections` | both | Redirect stub, symmetric | `no action` — same |
| `settings/authority` | both | Live page; the organization variant passes an organization, the personal one passes none | `no action` — functionally paired. *Falsifier:* if the variant without an organization is the only working one, the organization page is broken and this is `repair` |
| `settings/integrations` (+6 sub-routes) | both | **Live and heavily used — linked from the main sidebar, not the settings menu** | `no action` — reachable in both contexts by construction. *Falsifier:* anyone treating the settings sidebar as the settings inventory reads this as dead and deletes it |

### S2 Pairing the two trees

**Derivation:** the union of both directory listings → **24** distinct slugs. `[source]`

**Paired — 19 slugs:** `agents`, `ai-memory`, `ai-models`, `ai-providers`, `api-keys`, `audit-log`, `authority`, `billing`, `danger-zone`, `data-connections`, `firecrawl`, `general`, `integrations`, `mcp`, `openapi`, `prompts`, `rag-providers`, `search-providers`, `usage`. All `no action` at route level.

Two of them share a slug while being different features: `general` is a profile page on one side and an organization page on the other; `danger-zone` deletes an account on one side and an organization on the other. Both sides exist, so neither is personal-exclusive — but a mechanical route-pairing sweep would treat them as trivially paired, and they are not.

**Unpaired — the personal-exclusive settings surface was exactly three routes.** The whole personal settings tree was removed on 2026-08-27 and replaced by a single catch-all that redirects into the caller's organization, so every row in this section now describes what a path *was*. The enumeration is kept as it stood, because the disposition each route carried is what the removal acted on.

Four pages turned out to be account-global rather than personal — a profile, account security, notification preferences and account deletion — and moved to `settings/account/*` inside the organization rather than merging by slug. Two of them would have collided outright: `general` is a profile on one side and an organization's settings on the other, and `danger-zone` deletes an account on one side and an organization on the other. That second collision is why a slug-for-slug redirect was not available: a bookmark to delete an account would have landed on the page that deletes the organization.

| Slug | Disposition + reason |
|---|---|
| `ai-gateway` | **Removed 2026-08-27** — was `remove`; see S1 |
| `notifications` | **Built 2026-08-27** — an organization-rooted route now renders the same account-global page, and the settings menu carries it in an Account group. The route was never the data question; that one is answered in the data-model section and is unchanged |
| `security` | **Built 2026-08-27** — was `build equivalent`. An organization-rooted route now renders the same account-global page, and the sidebar and user menu both offer an account-settings link in organization context, which closes the S5 gap. The data stays account-global: no organization is passed in, and nothing was moved |

**Organization-only — two:** `members` and `user-activity`, both `no action`. *Falsifier for both:* if every migrated user lands in a single-member organization, the members page's solo state and the activity dashboard showing one actor become first-run product questions.

### S3 The notifications contradiction

The ticket names notification settings as its confirmed example of a personal surface requiring migration. The code does not support that.

The route is unpaired — it exists only in the personal tree. The **data** is not personal at all: both preference tables are keyed per user with an organization column no caller can populate, and the API doc-comment says so outright — *"Preferences are account-global (per-user, not per-org) — the same toggles apply in every workspace."* The mechanism, the per-model caller verification and the disposition are in the data-model section, which is authoritative for it. `[source]`

**Personal by route, account-global by data.** There is nothing to migrate. What must be decided is only where the *page* lives — the same question `security` raises, answered together with it.

This is lifted to the headline section because it suggests the ticket's estimate of "what is personal" was formed from route shape rather than data shape.

### S4 The same reconciliation across the whole route tree

A navigation-based comparison is structurally blind to any route no navigation entry links — and S1 already showed such routes exist here. So the tree is diffed directly.

**Derivation:** account-group directories against organization-slug directories → **101** versus **113**; **8 account-only**, **20 organization-only**. `[source]`

**Account-only — the personal-exclusive non-settings surface:**

| Route | Disposition + reason |
|---|---|
| `automation-templates` (+ `[id]`, `new`) | **Built 2026-08-27** — was `build equivalent`. All three routes now exist under the organization slug and render the same components with the organization threaded in. The route alone was not the job: the list, card and editor hard-coded the personal path in five navigations, so mounting them under an organization would have rendered correctly and walked the user back into the personal tree on the first click. They now derive their base path from the active workspace |
| `settings/ai-gateway` | **Removed 2026-08-27** — see S1 |
| `settings/notifications` | **Built 2026-08-27** — paired; see S2 |
| `settings/security` | **Built 2026-08-27** — paired; see S2 |
| `test`, `test/external-api` | `remove` — a developer harness inside a production route tree, with no inbound link. The only rows here whose removal is independent of the migration |

**Organization-only — 20 directories, four features:** agent routes (13) and frame routes (3) are **mirrored ungrouped** and reachable in both contexts; prompt governance and nominations (2) and the two organization settings pages are genuinely organization-only. All `no action`.

**Ungrouped routes.** Two trees sit outside both groups. An ungrouped route only ever matches a URL with no organization slug — the personal-rooted shape — so it is personal-by-construction despite living outside the account group. `[source]`

| Route | Disposition + reason |
|---|---|
| `/app/agents/document-generator` | `remove` — the component's own doc-comment states the split, and organization context reaches the identical component through the dynamic chat route |
| `/app/agents/cuga-generalist` | `remove` — same; the organization chat route special-cases these agent ids |
| `/app/agents/task-planner` | **Built 2026-08-27** — was `build equivalent`. The workspace moved to `apps/web/modules/saas/agents/components/TaskPlannerWorkspace.tsx` and both route trees mount it; it already read its tenant from the organization context hook, so no per-context copy was needed |
| `/app/agents/register` | **Repaired 2026-08-27** — was `repair`. The organization group now has a static `register` segment, so the slug-prefixed link no longer falls through to the dynamic agent route with the literal `"register"` as an id. The form moved to `apps/web/modules/saas/agents/components/RegisterExternalAgent.tsx`; its post-registration redirect hard-coded the personal agents list and now follows the active base path |

### S5 Navigation parity — on the right evidence

A running deployment showed identical navigation in both contexts. That is **corroboration, not the primary evidence**: a deployment samples one flag configuration at one moment.

**The durable evidence is the construction of the array.** Across the 145 lines that build the navigation sections: **zero** occurrences of any context predicate, and **15** uses of a single base-path variable computed once. `[source]` Every destination is that variable interpolated. **There is no context branch inside the navigation array**, so parity is a property of the code, not of a deployment.

The only per-item branch in the sidebar body is the project shortcuts, and they branch on *the project's own* organization — precisely so a guest's shortcut links into the project's host organization rather than their own context.

The flags gating nav entries are themselves tenant-blind: feature-flag overrides are instance-wide with no tenant scope. Flipping one changes both contexts together. `[source]`

**13 linked destinations**, of which three are configuration-dependent — the unified agent interface flag (which changes a *destination*, not an entry's presence), the prompts feature key, and the switcher's own enable/hide pair.

**Disposition: `no action`** — parity is structural, so elimination changes nothing about which entries render. *Falsifier:* any nav entry acquiring a context branch, or the base-path variable gaining a third value, breaks the by-construction argument.

**What the deployment observation does not support.** It supports parity of the **linked navigation set** at one configuration. It does not support parity of the non-settings surface as a whole — S4 found eight account-only route directories, and the personal-only ones are *precisely* the routes no navigation entry links. That is why the tree diff, not the navigation comparison, is the primary instrument.

### S6 Affordances that are not settings pages

**The context switcher.** The component, its "Personal account" block — the sole affordance that sets the active organization to null — and its three render sites (mobile drawer, collapsed rail, expanded sidebar) are all `remove`. With one tenancy there is nothing to switch between; the workspace identity moves to a non-interactive header. `[source]`

*Worth lifting:* setting the require-organization configuration key to true **already** hides the personal block and redirects organization-less users to the creation page. `[inferred]` A partial elimination lever therefore exists today and can be exercised before any migration — which is also what makes S2's `build equivalent` on `security` urgent rather than theoretical: with that key on, the security page is reachable only by hand-typed URL.

**The account-utility link.** This is the one place in the shell where the two contexts genuinely diverge, and it diverges in **two** components — the sidebar utilities and the user menu — each rendering an account link only outside organization context and an organization link only inside it. The two branches are mutually exclusive. `[source]`

**Disposition `repair` for both.** After elimination the account link collapses to the organization variant and the account-level surface loses its last entry point. A repo-wide search for hardcoded personal-settings links returns hits only from inside the personal settings tree itself, one rewrite target, and the notifications entry-point component. `[inferred]` **From organization context, the personal settings tree is reachable through the switcher and nothing else** — so today an organization-context user already has no link to their own account settings, and elimination makes that permanent rather than causing it.

**Interface strings.** A walk of the translation file collecting values matching *personal* returns **17**, of which 5 are "personal access token" (credential names, unrelated to tenancy). A second walk over key names adds two whose value omits the word. **14 tenancy-naming keys.** `[source]`

- `remove` — the switcher label; and the account-settings subtitle, which a repo-wide search shows has **zero consumers** and is already a dead key.
- `repair` — the notification settings hint, four audit-log keys whose key names encode tenancy their values do not, three API-key action labels (they describe a key *class* that survives elimination, so they should name the class, not the tenancy), and the audit-log explorer explanation.
- **Deferred to the data model** — the prompt scope enum's label and two tooltip strings naming the scope choice. Whether that scope survives is a data question.

Non-i18n literals naming the personal workspace live in at least seven components and two catalogs — `repair`. A translation-key sweep does not catch them, so a repair pass has to grep for literals separately. `[source]`

**Onboarding registry.** The registry declares a scope type with a personal value; **three** entries carry an explicit scope. Security and billing are `repair` (they follow wherever their routes land, and the scope field becomes meaningless); the members entry is `no action`. The drawer's filter itself is `remove` — with one tenancy both its branches are dead. `[source]`

CI enforces registry-to-anchor consistency, so any of these changes must land in the same commit as the surface it describes.

### S7 The project-guest presentation — outside the ticket's stated scope

**This originates here and is routed to the product owner. The ticket does not mention it.**

Users whose only access is a shared project are **deliberately** presented the personal workspace inside the host organization. This is not an accident of the tenancy model — it is documented as intentional in four independent places `[source]`:

- The sidebar: *"Project-only guests are presented their PERSONAL workspace inside the host org: the switcher reads 'Personal account' for them, so the nav and the account utilities must be the personal variants rooted at `/app` — the host org is never named or linked in their chrome."*
- The switcher: *"Project-only guests must not see the host org's identity in the switcher — present their personal account instead."*
- The project vocabulary file: *"Resolution is per tenant, and deliberately not exclusive for guests: someone whose only access is a shared project is presented the personal workspace."*
- The organization settings layout **redirects guests out entirely.**

Taken together: a guest's *entire* chrome — base path, account-utility link, switcher label, admin route — is the personal variant, and the personal settings tree is the only settings tree they may see. **Eliminating the personal workspace removes the guest presentation surface outright**, and there is no fallback: the organization settings layout actively bounces them, and the organization identity is deliberately withheld from their chrome.

**Disposition `build equivalent`** — a guest needs a presented workspace that is neither the host organization (whose identity is deliberately hidden from them) nor the personal workspace (which is being removed). No such surface exists. This is a design question about what a project-only guest sees, and it reaches the product owner as a scope addition rather than an implementation detail.

---

## Data model, tenancy classes, and the residual

*Scope: how personal context is encoded in stored data, organized so that nothing carrying a tenant column falls outside the organization.*

### D1 The query layer's tenancy classes

Tenancy is applied by `getTenantFilter` in `packages/database/src/tenant-db.ts`, which selects a filter shape per model from a set of named classes. Each class disagrees with the others about whether the organization branch keeps a per-user predicate — that disagreement is what the visibility analysis in the resolution section turns on.

**Derivation:** `grep -nE "_TABLES(: | = )" packages/database/src/tenant-db.ts`, counting entries per class → **7 declared classes**. Six are sets and one is a keyed record, which is why a set-only pattern finds six. The six sets hold **114 distinct models** (two appear in more than one); adding the record's 53 keys brings the union of all seven to **125**. `[source]` `[source]`

| Class | Models | Organization branch | Personal branch | Evidence |
|---|---:|---|---|---|
| `STRICT_ISOLATION_TABLES` | 4 | `{ organizationId, userId: null }` | `{ userId, organizationId: null }` | `[source]` |
| `PER_USER_ORG_TABLES` | 13 | `{ userId, organizationId }` | `{ userId, organizationId: null }` | `[source]` |
| `SCOPE_BASED_TABLES` | 4 | `scope IN (SYSTEM, ORGANIZATION)` + `organizationId` | `scope IN (SYSTEM, USER)` + `userId` | `[source]` |
| `USER_OWNED_TABLES` | 86 | `{ organizationId }` — **no user predicate** | `{ userId, organizationId: null }` | `[source]` |
| `ORG_ONLY_TABLES` | 7 | `{ organizationId }` | `{ organizationId: "___BLOCKED___" }` — annotated *"Will match nothing"* | `[source]` |
| `PROJECT_SCOPED_TABLES` | 53 | An OR-ed carve-out on the caller's accessible projects — **not** an organization predicate | Same carve-out | `[source]` |
| `SPECIAL_TABLES` | 2 | handled individually | handled individually | `[source]` |

`ORG_ONLY_TABLES` is the only class whose personal-context behaviour is deliberate blindness rather than filtering: it returns a sentinel that matches nothing, so personal callers see an empty set rather than a filtered one. Disposition **`no action`** — the personal branch is already an intentional dead end and holds no rows. *Reason:* eliminating personal context removes an unreachable code path, not data. *Falsifier:* a row in any of these seven tables is found with a null organization, which would mean it was written by a path that bypasses this filter — that would be `repair`.

### D2 The residual — what the taxonomy does not cover

**The classes do not cover the population.** A grouping that stops at the class list would report as reviewed a third of the models it never looked at.

**Derivation:** models declaring `organizationId String?` minus the union of every `tenant-db.ts` class →

```
187 models with a nullable organizationId
125 models registered in some tenant-db class (six sets + the project-scoped record)
109 of those 187 are among them
 78 nullable-tenant models registered in no class at all
```
`[source]`

The reconciliation is **109 + 78 = 187**: of the 187 models carrying a nullable organization column, 109 are registered in some class and 78 are registered in none.

The class total of 125 is a different population and does not enter this sum — it counts every model any class names, including models whose organization column is required rather than nullable.

**The project-scoped class is the one that made this hard.** It is declared as a keyed record rather than a set, so a set-only pattern misses it — which is how the first pass of this document reported it as empty and counted three of its members as unregistered. It is also not a tenant filter in the usual sense: it is a carve-out the caller ORs into the tenant filter so a guest can read a shared project's data *in addition to* their own tenant context, and for a table in no other class it is the **only** filter. That makes it directly load-bearing for the guest question in the decisions section.

The residual is not a footnote. It contains the models the decisions section rests on — `AiUsageLimit`, `Notification`, `Subscription`, `MaturationApprovalPreference`, `Skill`, `AgentDeployment`, `PromptBinding`, `DataConnectionCredential` — none of which is filtered by the class matrix at all. `[source]`

**The 78 residual models, by name.**

`AgentDeployment`, `AgentDeploymentExecution`, `AgentMemoryEdit`, `AgentMemoryFile`, `AgentTemplate`, `AgentTemplateConversation`, `AgentTemplateExecution`, `AgentTemplateInstance`, `AiProviderFallback`, `AiUsageLimit`, `ApprovalTemplate`, `ArchitectureDecision`, `ArchitectureDecisionComment`, `ArchitectureDecisionVersion`, `AtlasAnalysis`, `AtlasAnalysisRun`, `AtlasConversation`, `AtlasCrossEdge`, `AtlasCrossLink`, `AtlasCrossLinkRun`, `AtlasEdge`, `AtlasEdgeOverride`, `AtlasEdgeOverrideHistory`, `AtlasNode`, `AtlasNodeOverride`, `AtlasNodeOverrideHistory`, `AtlasParseCheckpoint`, `AtlasSystemLayout`, `BacklogUpdateSession`, `ChannelThreadMapping`, `ChatArtifact`, `DailyBrief`, `DailyBriefView`, `DataConnectionCredential`, `DecisionLogEntry`, `DocumentAssistantConversation`, `EpisodicMemory`, `FrameTemplate`, `GoldenReference`, `IntegrationApproval`, `MCPClientSession`, `MCPOAuthState`, `MaturationApprovalPreference`, `NewsletterChatDelivery`, `NewsletterDelivery`, `NewsletterSend`, `NewsletterSettings`, `NewsletterSubscriber`, `Notification`, `OrchestratorMemoryPreferences`, `PendingBacklogProposal`, `PmSyncLog`, `ProjectBriefCursor`, `ProjectContextSummary`, `ProjectDocumentAsset`, `ProjectLinkedSlackChannel`, `ProjectLinkedTeamsChannel`, `ProjectLinkedTeamsChat`, `ProjectMeetingActionItem`, `ProjectScan`, `ProjectScanCheckpoint`, `ProjectScanConfig`, `ProjectSlackHuddleNote`, `ProjectUserFunctionTag`, `PromptBinding`, `PromptNomination`, `RequestSpan`, `ScanActivity`, `ScanFinding`, `ScanFindingGrouping`, `ScanFindingReview`, `Skill`, `StoryTaskComment`, `Subscription`, `TaskQueueShard`, `TemplateInstanceArtifactEmailDelivery`, `UserStoryComment`, `WeavePlanTemplate`

Disposition **`drop`** for the residual as a population. *Reason:* these rows carry a tenant column and are reached by hand-written queries rather than by the class matrix, so each is filtered by whatever its own call sites do — the migration must move them, but the class matrix gives no guidance on how. *Falsifier:* any residual model whose tenant column turns out to be non-tenant metadata rather than a filter — the schema already contains one such case, annotated *"Neither column is a tenant filter"* — moves to `no action` and must be named individually. `[source]`

### D3 The second encoding — personal as empty string

Four models depart from the null convention entirely. They are not in the 187 (they are not nullable) and not in the 114 (they are not classified), so **they fall outside both populations above.**

**Derivation:** `grep -nE 'organizationId +String +@default\("")' packages/database/prisma/schema.prisma` → **4 models**. `[source]`

The in-schema rationale states the reason directly: the empty string was chosen because *"Prisma compound unique does not handle null cleanly"* — that is, to sidestep the constraint hazard recorded in the hazards section. `[source]`

**They split into two groups that look identical in the schema and take opposite dispositions.** The split is decided by whether any caller ever writes a real organization identifier, which the schema cannot tell you.

| Model | In-schema comment | Do callers write a real org id? | Disposition + reason | Falsifier | Evidence |
|---|---|---|---|---|---|
| `UserOrchestratorPreferences` | `"" = personal account, non-empty = organization-scoped` | **Yes** — the trust-manager writes a real organization on both the lookup key and the create payload | `drop` — **but coupled.** An organization-context read that misses its per-org row falls back to the user's `""` row, annotated *"One-time transition fallback for the per-org cutover"*, so that row is read from **both** contexts. Migrating or clearing it changes what existing organization users see | The fallback is retired before the migration runs, which decouples the row and makes this a plain move | `[source]` |
| `UserChatAgentSelection` | `"" = personal account, non-empty = org-scoped` | **Yes** — same pattern | `drop` — same | As above | `[source]` |
| `NotificationPreference` | `"" = account-global (reserved for future per-org scoping)` | **No** — every read and write routes through a normalizer collapsing `null \| undefined \| ""` to `""`, and the bulk reads hardcode `organizationId: ""`. No call site supplies an organization | `no action` — the column is inert; the data is already one row per user and survives untouched | Any caller is added that populates the column, which would convert it to `migrate` | `[source]` |
| `NotificationDeliveryPreference` | `"" = account-global (mirrors UserOrchestratorPreferences)` | **No** — same normalizer | `no action` — same | As above | `[source]` |

**This is where the ticket's headline example resolves.** Fizzy #1875 names notification settings as its confirmed instance of a personal-context feature requiring migration. The two notification tables are account-global by construction and need no migration; the two tables that *do* need it — orchestrator preferences and chat-agent selection — are not mentioned in the ticket at all. Lifted to the headline section.

**The consequence beyond these four rows.** A completeness check written against the null encoding is blind to all four models. A scan reporting "zero personal rows remain" is simultaneously true and meaningless for them, and a `migrate` disposition and a `no action` disposition are indistinguishable from such a scan. The second encoding therefore has to be enumerated separately in every verification of this epic, not only in this section.

### D4 Relation closure

A model-level inventory proves that models were counted. It does not prove that a *record* moves intact.

**Derivation:** `grep -icE "(denormalized|copied) from (the )?parent" packages/database/prisma/schema.prisma` → **44 sites** where a tenant column is a copy of a parent's rather than an independent fact. `[source]`

The pattern is explicit in the schema: comments such as `// Tenant isolation (copied from parent Project)` and `// Tenant isolation (organizationId copied from parent Project)` appear on document, context, scan, activity, and audit child records. `[source]`

Three failure shapes follow, and none is detectable by a row count:

1. **Parent moved, child not.** The child keeps the old tenant value and now disagrees with its parent. Because the application tier — not the database — reads these columns, the child is filtered into a tenant its parent no longer belongs to.
2. **Child has no tenant column of its own.** It derives tenancy through the parent relation, so it moves silently and correctly — but it also cannot be counted by any query over tenant columns, which means it is invisible to completeness evidence.
3. **Cross-context reference survives.** A record in one tenant references a record in another. Legal today wherever a guest carve-out grants project access; illegal after elimination, and nothing detects it.

Disposition: **every `remove` disposition is conditional on its relation trace**, and every `drop` one inherits the trace as a description of what becomes unreachable together. *(Before the no-migration ruling this bound the `migrate` set too — that is now counterfactual.)* *Reason:* the trace is the only thing that distinguishes "the rows moved" from "the records moved". *Falsifier:* a model whose tenant column has no parent and no children — those are complete at model level and need no trace.

### D5 What survives untouched

**Derivation:** models declaring a `userId` and no `organizationId` column of any kind → **17 models**. `[source]`

`Account`, `AgentApproval`, `DynamicAgentFavorite`, `Passkey`, `ProjectMember`, `PromptVote`, `Session`, `TwoFactor`, `UserApiKey`, `UserCloudProviderConfig`, `UserDeploymentQuota`, `UserModelPreference`, `UserRagProvider`, `UserSearchProvider`, `WorkspaceAdministrator`, `WorkspaceContributor`, `WorkspaceStakeholder`

Disposition **`no action`** — these are scoped per user with no tenancy dimension, so eliminating a tenancy mode cannot affect them. *Reason:* there is no column to migrate and no filter branch to remove. *Falsifier:* any of them is read through a tenant-filtered path that infers tenancy from a join rather than a column — `ProjectMember` is the candidate, since project membership is what grants the guest carve-out. That would make it `migrate`.

This is the largest single contribution to the inverse list: credentials, sessions, passkeys, two-factor enrolment, personal API keys, per-user model and provider preferences, and workspace role rows all survive the elimination without being touched.

---

## State that is not a database row

*Added after adversarial review. The sections above enumerate tenancy as it appears in relational columns. It appears in at least two other places, and neither is reachable by any derivation those sections run.*

Every enumeration above starts from the Prisma schema or the route tree. A store that encodes tenancy some other way is therefore invisible to all of them — the classes reconcile, the residual reconciles, every row carries a disposition, and the state is still stranded. This section exists because that is exactly what happened on the first pass.

### N1 Object storage encodes tenancy in the key, and rejects a key whose prefix no longer matches

`packages/storage/tenant-paths.ts` centralizes object-key construction so every key begins with an owner prefix. Its own header states the rule and its provenance `[source]`:

> *"Organization context: prefix = organizationId. Personal context: prefix = userId. The XOR is intentional — personal files must never appear under an org prefix and vice versa."*

and names why it exists — a post-breach credential and isolation audit. The reader guard is `isTenantOwnedKey`, which accepts a stored key only when it starts with the prefix derived from the **caller's current** tenant.

**Derivation:** `grep -rln "buildTenantStoragePath\|buildProjectStoragePath\|tenantOwnerPrefix\|isTenantOwnedKey" --include="*.ts" packages apps | grep -v __tests__` → **4 non-test files** `[source]`. Models storing an object key: `grep -nE "storageKey|evidenceKey" packages/database/prisma/schema.prisma` → **6 sites** across document, attachment, evidence, step-log and skill models `[source]`.

**Disposition: `drop`** — the objects stay under their owner prefix and become unreachable with everything else personal. *Reason:* the tenant identity is inside the stored key, so re-tenanting the row without re-keying the object leaves a pointer whose prefix the read guard now rejects. The row migrates; the file becomes unreachable. *Falsifier:* an object whose key is project-scoped rather than tenant-prefixed — several are, and those move with their project rather than with their owner. The split has to be enumerated per model, not assumed.

**Consequence for cost.** This is the silent-loss mode the ticket commissioned this audit to prevent, and a relational migration cannot detect it: the row is present, correct, and points at a key that no longer resolves. It also constrains the ninety-day archive — restoring rows without restoring object reachability restores nothing a user can open.

### N2 The vector store separates tenants physically, not by filter

`packages/rag/lib/vector-store/store.ts` states the model in its header `[source]`:

> *"Personal data (organizationId = null): Shared collection with userId filtering. Organization data: Dedicated collections per organization for physical isolation."*

The two contexts are not two filters over one store. Personal embeddings live in a **shared** collection and are separated by a filter; organization embeddings live in a **dedicated collection per organization**.

**Disposition: `drop`** — under the current direction nothing moves, so the embeddings stay in the shared collection and go unreachable with their source rows. Recorded here because the cost below is what a *later* decision to migrate would face. *Reason:* migrating a user means their embeddings must leave a shared collection and populate a newly-provisioned one, which is a copy or a re-embed, not an update. Neither the collection nor the operation exists today for this direction. *Falsifier:* if a destination organization's collection can be created and back-filled from the shared collection by pointer rather than by re-embedding, the cost drops sharply — but it is still not a column write.

**Consequence for cost.** Re-embedding has a real monetary and wall-clock cost proportional to stored content, and it is the one item in this document whose price is not paid in engineering time alone. It also interacts with the cutover hazard: a user whose rows have migrated but whose vectors have not gets retrieval results from neither collection.

### N3 What this section does not cover

The two stores above were found by adversarial review after the relational enumeration was complete. **That is evidence about the method, not just about these two stores.** No derivation in this document establishes a repository-wide population of state-bearing systems, so the following are named as unexamined rather than as absent:

- Caches and session stores holding tenant-derived keys
- Durable workflow and schedule payloads carrying a tenant at rest — the hazards section inventories them as *writers*, not as *stored state*
- External provider state keyed by tenant — integration installations, webhook registrations, per-tenant credentials at a third party
- Search indexes other than the vector store
- Anything a future storage adapter introduces

**Before the migration is designed, a repository-derived inventory of storage adapters and stateful clients is required**, with each entry either analyzed or excluded with evidence. Until that exists, this document's completeness claim is bounded to relational state plus the two stores above.

---

## Tenancy resolution, authorization, and external entry points

Everything here hangs off a single session field. One session field decides, per request, whether the caller is in an organization or the personal workspace. Three separately-maintained functions re-derive that decision for three different consumers. Two authorization behaviours are conditional on the answer: what a caller may *do*, and what a caller may *see*.

Because the decision is re-derived rather than shared, a disposition has to be applied three times. Because both authorization behaviours are conditional on it, elimination changes capability and visibility at once, in opposite directions.

**Read R2 before R3.** The destination organization is the input to both authorization questions; deciding it later means re-pricing them.

### R1 The origin, and the three resolvers

The fork is created once, in the tenant middleware, which reads the session's active organization and branches to an organization or personal context. The same block looks up the caller's organization role **only when an organization is present** — so in personal context the role is null for the whole request. That null is what R3 and R4 are about. `[source]`

**Derivation:** functions that resolve an organization from session or input across the API package, exported or not, excluding tests → **3**. `[source]` The duplicated one is module-private, which is itself why nothing enforces its own keep-in-sync instruction.

| Resolver | What makes it a separate cost | Disposition + reason | Falsifier |
|---|---|---|---|
| `packages/api/orpc/procedures.ts` — the primary resolver | Five-level precedence. An explicit null returns undefined and deliberately does **not** fall back to the session. Called from **545** non-test files. | `retarget` — the two branches producing undefined must resolve to the destination organization; nothing else is personal-specific | A caller depends on undefined meaning *account-global, deliberately not organization-scoped* rather than *personal*. That caller needs `build equivalent` |
| `packages/api/orpc/middleware/require-permission.ts` — a hand-maintained copy | Duplicated to avoid an import cycle; its own doc-block ends **"Keep this in sync"**, and nothing enforces that | `retarget` — the same change, applied a second time | The import cycle proves breakable, which makes this `remove` (delete the copy, import the original) — strictly cheaper, and worth offering before approving two parallel edits |
| `packages/api/modules/v1/helpers.ts` — REST only | The only resolver driven by a **client-supplied flag** rather than session state. Reached from 54 call sites across 15 route files | `retarget` — the flag branch and the final fall-through must resolve to the destination; the organization-key and explicit-organization branches already verify membership | An external consumer depends on the flag's current meaning — see R6, where the flag carries its own disposition and is governed by no acceptance criterion |

### R2 Destination organization — decide this first

The ticket specifies a **new, separate, private organization per user**. A merge would inherit an existing role and an existing member list, and every consequence in R3 would change.

Two facts constrain it. **No organization is created at signup today** — the account-creation hooks send a welcome email, seed configuration, and reconcile invites, and create nothing. And when an organization *is* created, the creator's membership row is written in the same flow with the top role. `[source]`

**The provisioning mechanism itself is `build equivalent`** — nothing creates an organization at signup, and the existing creation path is browser-driven, so there is no server-side hook to reuse. The ticket settles the naming: the auto-created organization is named after the user rather than carrying a fixed label.

The four user categories and their consequences are tabulated in the decisions section. Two structural facts belong here:

- **Deletion.** **152** relations declare cascade-on-delete against the organization; exactly **one** declares set-null — the audit log, deliberately preserved. `[source]` So the organization danger-zone action becomes a way to destroy what used to be personal data. Today the equivalent destructive act is account deletion.
- **New members.** See R3-d: the moment a second member joins, 86 tenancy-class tables become readable to them, with no further migration and no second decision.

### R3 Authorization moves in both directions

#### Direction 1 — capability gets stricter

In personal context the organization role is null and every permission middleware returns early. There is no personal permission resolver at all: the permissions package exports organization and project resolvers and no personal equivalent. The only genuine personal-context authorization primitive is a project-owner short-circuit that passes unconditionally, annotated *"including ones outside the OWNER project permission set"*. `[source]`

So today, on your own data, you are effectively unbounded. Afterwards you hold a role, and the ladder is cumulative. The gap that matters is the middle role, which grants create and update across the board but **no delete** — every delete permission first appears one rung higher, along with integration connect and disconnect and organization key management. `[source]`

Under the ticket's mapping every user is owner of their destination, so **this direction is neutral at cut-over**. It becomes live the moment the destination is not private any more, or if a merge is chosen. That conditionality is the finding: the capability direction is priced at zero *because of* the destination choice, not independently of it.

#### Direction 2 — visibility: rows become shared

The organization branch is not uniform across classes. The exact filter shapes are in the data-model section; what matters here is a single column of it — whether the organization branch keeps a per-user predicate. One class does not, and it is by far the largest.

| Class | Models | Does the organization branch keep a per-user predicate? | Where a migrated row lands | Disposition + reason | Falsifier |
|---|---:|---|---|---|---|
| `STRICT_ISOLATION` | 4 — including `Purchase`, `AiCreditAccount` | No — and it requires the user column to be **empty** | **Neither — stranded.** A migrated row carries *both* keys, so it fails the organization branch's null-user requirement and the personal branch no longer runs. **The rows become invisible.** | `drop` — migration here is not "set the organization"; the user column must be cleared in the same statement or the rows disappear from every read path | Any consumer reads the user column for attribution — billing receipts and credit ledgers are the obvious candidates. Clearing it then destroys attribution and the class needs `build equivalent` |
| `PER_USER_ORG` | 13 | **Yes** | **Capability only** — the per-user predicate survives; other members still cannot read these rows | `drop` — the safe class; the filter shape is already what a migrated row needs | A uniqueness collision surfaces at cut-over, which makes it `repair` before `drop` |
| `SCOPE_BASED` | 4 | No — it selects on a scope enum instead | **Both, and it is a product decision which.** A personal row carries user scope, which the organization branch does not select — stranded unless the scope is rewritten, and rewriting publishes the row to every member. No third option inside this filter | `drop` — the migration cannot be scope-neutral | The product owner confirms a user-scoped prompt or agent should stay author-private inside an organization. That needs a per-user predicate this class lacks — `build equivalent` |
| `USER_OWNED` | **86** — including `Project`, `ProjectDocument`, meeting transcripts, `Workflow`, `Agent`, `DataConnection`, AI usage, **`AuditLog`** | **No — none at all** | **Visibility.** Three quarters of the tenanted models. Each row loses its per-user predicate and becomes readable by every member of the destination | `drop` — under the ticket's mapping the destination has one member, so nothing is exposed *at cut-over*; the exposure is structural, not gated, and activates on the first invitation | A per-table review finds content here the product owner will not accept sharing on invitation. Those tables need reclassification, which is `build equivalent` and changes the filter for existing organization users too |
| `ORG_ONLY` | 7 | Not applicable — personal returns a sentinel matching nothing | **Neither** — personal context cannot reach this class, so there is nothing to move | `no action` — an intentional dead end; elimination removes an unreachable path and no rows | A row is found with a null organization, meaning it was written by a path bypassing this filter — an orphan, and `repair` |

### R4 The permission skip is a two-condition guard — only one condition is personal

This is the trap. The guard reads:

```ts
if (!context.tenantContext || context.tenantContext.type === "personal") {
    return next();
}
```

**Only the second condition encodes personal context.** The first fires when a procedure has no tenant context at all — and the type declaration says so deliberately: procedures built on the plain protected builder leave it undefined, *"and we treat that as personal-context equivalent below — the procedure author opted out of tenant isolation."* `[source]`

Deleting the personal condition therefore closes **half** the bypass. Every procedure on the plain builder keeps skipping organization role checks, silently, because the guard still has a truthy branch to take. **A change that deletes the personal check and reports the bypass closed is wrong.**

**Derivation:** files calling the permission middleware, split by whether they use the tenant-aware procedure builder → **314 tenant-aware / 52 plain**. `[source]`

| Guard | Shape | Disposition + reason |
|---|---|---|
| Primary permission middleware | Two-condition | `retarget` — removing the second condition is the intended change |
| Guest-allowing variant | Two-condition, identical text | `retarget` — same change, second site; its guest path resolves from project membership and is independent |
| Input-organization variant | One-condition, on the resolved organization | `retarget` — after elimination the resolved organization should never be falsy, so the early return becomes unreachable by contract; leaving it preserves a silent skip if the resolver ever returns undefined again |
| **The residual bypass** — the first condition, across the 52 files | Survives elimination untouched | **`repair`** — today "no tenant context" has a documented meaning and personal rows were user-scoped anyway. Once personal context does not exist, that meaning is gone: a procedure with no tenant context skipping an organization role check is an **unguarded organization-scoped operation**. It does not become a defect *until* elimination ships, which is exactly why it must be on the plan for the same release |
| Project-owner short-circuit | Ownership derived from the project row, not tenancy | `no action` — unaffected. *Falsifier:* if ownership turns out to be derived from the project's personal tenancy rather than stored independently, this becomes `migrate` |

### R5 The actual enforcement layer is the application tier

The database's row-level policies are **not** the backstop the surrounding comments imply. The engineering facts are verifiable here without reference to the internal finding that records it:

- The tenant-aware database client and its context helpers exist, but application procedures do not use them — they query through the plain client, so the per-request session variables the policies test are never set on the query path.
- The base client is a plain adapter over a single connection string and sets no such variables.
- A policy-subject database role is provisioned only under a deployment path that is not the one in use.

Two consequences. First, **the personal branches inside the policies are inert** — not a second line of defence behind R3, and a migration reasoning only about them changes nothing that is actually enforcing. Second, they are still there, encoded as a null-organization test across every policy shape, so if the connecting role is ever made policy-subject they become live in one step against data that no longer has null-organization rows.

| Item | Disposition + reason | Falsifier |
|---|---|---|
| Personal branches in the generated policies | `retarget` — their contract must be narrowed even though runtime behaviour is currently inert. `no action` would mean *survives untouched*, and the follow-on register below requires every generated template and its header to be rewritten, so the label would contradict the document. `[deployment]` | The connecting role is changed to a policy-subject one, in this epic or independently. That makes every personal branch live at once and moves this to `repair`, with the policy rewrite becoming a prerequisite of cut-over |
| The application-tier filter as the real control | `retarget` — since this is the enforcement layer in fact, R3's class branches are the actual security change, not a convenience refactor, and should be reviewed as such `[source]` `[deployment]` | Evidence that some path bypasses the filter entirely — raw SQL, a worker connection, a job with no tenant context. Those are unfiltered today and stay unfiltered after, which is `repair` |

### R6 External entry points, and which criterion governs each

Four surfaces select or derive tenancy without a browser session. **The acceptance criteria do not cover them evenly.** Each criterion reaches a different class of surface, and the last column of the table below names which one governs each. Two rows read NONE — and those two are client-facing tenancy selectors on public surfaces.

**Derivation:** REST flag → 54 call sites across 15 route files. Protocol servers → 2 route files. Command line → 12 command files behind one selector. Webhooks → 8 routes, of which 4 derive tenancy. `[source]`

| Entry point | How it reaches personal | Governing criterion | Disposition + reason |
|---|---|---|---|
| The versioned REST query flag | A client-supplied flag. A personal key with the flag returns a null organization; without it, also null. An organization key plus the flag is rejected | **NONE.** AC3 brushes the subset that creates records; no criterion governs the flag as an interface contract — not on reads, not its removal, not what an existing caller receives once it is gone | `remove` — a client-controlled tenancy selector on a versioned public surface. With one tenancy it has no meaning, and leaving it accepted-but-ignored is worse than removing it |
| Streamable HTTP gateway | Personal-key authentication resolves to a null organization; it never consults membership or the user's last-active organization, even where one exists | AC10 / AC11 | `retarget` — a resolution default, not an isolation failure: the caller is correctly authenticated and correctly confined; the tenancy it lands in is simply the one being eliminated |
| Hosted protocol server | Two paths: one derives the tenant from caller-supplied request data (see R7); the unauthenticated public session resolves to a null organization | AC10 / AC11 | `repair` — carries the live defect in R7; the public-session default is a separate `migrate` of the same kind as the gateway |
| Command-line context selector | An explicit personal flag, plus a **persisted default** that survives across invocations and translates into the REST flag | **NONE.** Not a UI affordance, so AC12 does not reach it; not protocol resolution, so AC10/AC11 do not; AC3 reaches only the commands that create | `remove` — its whole purpose is choosing between two tenancies. Note the persisted default means an installed client keeps sending the removed flag until its user upgrades |
| Webhooks | Tenancy comes from a linked record, not from a caller, and can legitimately be null — the Teams path falls back through the linked channel to the project and writes a null-tolerant value at four sites | **NONE.** No user-facing creation, no protocol resolution, no UI | `retarget` — these derive rather than select, so they need no decision of their own. They are listed because they are where an *incomplete* row migration shows up as a runtime null rather than a failed query. *Falsifier:* a linked record still resolving to null after migration is an orphan, and the null-tolerant writes persist it silently rather than fail — `repair` |

One incidental note: a webhook path logs the literal string `"personal"` as a label. It feeds no query, but it is a fourth place the literal appears and will surface in any grep-driven sweep. `remove`, with whatever pass clears the literals. `[source]`

### R7 The two protocol defects are different items

Both concern how tenancy is established for a non-browser caller, and they are frequently discussed as one. They are not.

| Defect | Disposition + reason | Timeline |
|---|---|---|
| The gateway's personal-key path hardcodes a null organization, annotated in source as *"organizationId always null"*. It never consults membership and never consults the user's last-active organization, though that field exists and is populated | `retarget` — a resolution default, not an isolation failure. It moves with the epic and is governed by AC10/AC11. *Falsifier:* a deployment where this null is load-bearing for a non-tenant operation, which would make it `build equivalent` | Ships with the epic |
| The hosted server takes the tenant for a request from caller-supplied request data on one path without a membership check, whereas the equivalent in-protocol operation does perform one | **`repair`** — a cross-tenant isolation defect existing today, independent of this epic. It would still need fixing if #1875 were cancelled. Pricing it inside the epic buries an open security item behind a product migration's schedule, and fixing it depends on no decision here | **Its own remediation timeline, ahead of and separate from the epic** |

*The second is recorded at the level needed to schedule and staff it. The specifics — which path, and why the check is absent — are deliberately withheld while the defect is open.*

### Internal references

- The row-level-security latency finding restated in R5, with its deployment evidence and staged activation plan, and the remediation register it hangs off, live under the compliance tree, which is not in this repository — it was cut when this repository was sanitised. Cited here rather than in the body.

---

## Migration hazards — why this was declined

**The product owner ruled against migrating. This section is why that ruling is well-founded, and what a later decision to revisit it would face.** Every entry below describes a cost a migration *would* incur; none of it is live work under the current direction. The `migrate` references inside are counterfactual — read them as "if we moved this row".

Each entry prices a disposition: what makes an item cheap or expensive to move, remove, or leave alone. **None proposes a mechanism.** Schema shape, batching, ordering, rollback and archive design are later work. What is in scope is the cost being approved when a disposition is picked.

### H1 The audit trail is immutable by trigger, and this epic needs the one mutation it forbids

**This does not make a disposition expensive. It stops one.** Every other hazard here is a cost; this is a gate.

`audit_log` is append-only, enforced by a row-level `BEFORE UPDATE OR DELETE` trigger rather than by row-level security or grants. The installing migration says why: triggers, unlike policies, are not bypassed by ownership, so the guard binds every role including the table owner. That is exactly the property that makes the log tamper-evident against a compromised database role — and exactly the property that makes it unbypassable by a migration running as owner.

| Fact | Evidence |
|---|---|
| Trigger `audit_log_worm`, `BEFORE UPDATE OR DELETE ... FOR EACH ROW` | `[source]` |
| `UPDATE` is permitted only when non-tenant content is byte-identical **and** each tenant key is either unchanged or moving **to** `NULL`; anything else raises *"audit_log is append-only"* | `[source]` |
| The row seal deliberately **excludes** the three tenant keys, so re-tenanting raises no false tamper alarm — the seal is not the blocker, the trigger is | `[source]` |
| One precedent exists. Its own comment: *"This backfill moves `organizationId` FROM NULL to a value, which the trigger correctly rejects as tampering."* | `[source]` |
| It suspended the trigger inside one transaction and closes *"Authorised as a one-off by the product owner"* and *"A PERMANENT GUC BYPASS WAS DELIBERATELY NOT ADDED."* | `[source]` |
| It **deliberately excluded personal-context rows**: *"A personal-context project has no organization, so its rows are left alone — NULL is the correct value there, not a gap."* | `[source]` |
| Volume of personal-context audit rows — not measured; a required input before pricing | `[deployment]` |

The direction is what matters. The single permitted mutation is a tenant key moving **to** null — the delete-cascade path that preserves history when an organization is removed. This epic needs the opposite. The rows in question are precisely the rows the one prior backfill was written to leave alone.

**Disposition affected:** `migrate` on the audit trail, and on every item whose evidence of past activity lives there.

**Consequence.** The choice is binary and both branches cost. Either the trail is split at the migration boundary — organization admins see nothing a migrated user did beforehand, because that surface filters strictly on the organization — or the rows are backfilled under a repeat of the same one-off authorisation, meaning the approver is the product owner personally and the approval is per-run, not standing. `[inferred]`

A second-order cost: the personal audit-log reader is a route of its own. If that route is dispositioned `remove`, the split-off rows become unreachable from any surface — the exact defect the earlier backfill repaired. `[inferred]` **The two dispositions cannot be approved independently.**

### H2 Thirteen unique constraints that do not currently constrain

Postgres treats null as distinct in a plain unique index, so every constraint including a nullable organization column restrains organization rows only. Personal rows fall straight through. Duplicates that are legal today become violations the moment the column is populated.

**Derivation:** models declaring a nullable organization column *and* a `@@unique` naming it →
```
awk '/^model /{m=$2;nul=0} /^[[:space:]]*organizationId[[:space:]]+String\?/{nul=1} \
     /@@unique\(.*organizationId/{if(nul)print m}' packages/database/prisma/schema.prisma | sort -u
```
→ **13 models** `[source]`

`MaturationApprovalPreference`, `MCPServer`, `Prompt`, `PromptBinding`, `OpenAPIService`, `OpenAPIServiceConfig`, `AgentWorkspaceFile`, `AiProviderFallback`, `AgentDeployment`, `Skill`, `OrchestratorMemoryPreferences`, `DynamicAgentConfig`, `DataConnection`.

**Twelve of the thirteen are uncompensated.** Only `MaturationApprovalPreference` has a hand-written partial index guaranteeing one personal row per user. `AgentDeployment` is the sharpest case: its constraint is on organization and slug, so personal deployments have **no slug uniqueness at all**.

The repository already knows this trap and documents it in four places — two migrations that compensate by hand, and two schema comments stating the reasoning, one of which describes deliberately *excluding* the organization from a constraint to avoid *"the Postgres 'NULL is distinct' trap that would let personal-context duplicates slip past a compound unique"*. `[source]`

**Disposition affected:** `migrate` on all thirteen.

**Consequence.** For the twelve uncompensated, today's data can legally contain rows a populated organization column would make illegal — one user with two prompts sharing a key, two same-slug deployments, two skills sharing slug and scope. `[inferred]` A `migrate` disposition on any of them therefore costs a **content decision**, not just a data move: someone must decide per model which duplicate wins and what happens to the loser, and that belongs to whoever owns the feature. A prompt-key collision and an agent-slug collision are not the same product question. How many collisions exist is unmeasured and must be counted before pricing. `[deployment]`

### H3 The second encoding is invisible to null-based verification

Restated from the data-model section as its consequence: four models encode personal as an empty string, so a migration — or a completeness check — predicated on a null tenant is blind to all of them.

**Consequence.** A count reporting "zero personal rows remaining" over the null encoding is simultaneously true and meaningless for these four, and a `migrate` disposition and a `no action` disposition are indistinguishable from such a scan. `[inferred]` The cost is not the data — two of the four are already account-global and cheap to leave alone — it is that **the completeness evidence for the whole epic is wrong by construction unless the second encoding is enumerated separately.** That makes this an input to every other disposition, not a line item of its own.

### H4 Cutover has no single writer to stop

Tenant selection is enforced in the application tier, not the database, by three hand-duplicated resolvers. There is therefore no single point at which the personal mode stops accepting writes.

**Writer inventory — derived, not recalled.**

Step 1, the population of models capable of personal tenancy (nullable plus empty-string):
```
awk '/^model /{m=$2} /^[[:space:]]*organizationId[[:space:]]+String\?/{print m} \
     /^[[:space:]]*organizationId[[:space:]]+String[[:space:]]+@default\(""\)/{print m}' \
  packages/database/prisma/schema.prisma | sort -u | wc -l
```
→ **191** of 297 models `[source]`

Step 2, create and upsert call sites against exactly those models, excluding tests and generated code → **382 call sites across 208 files** `[source]`

Step 3, classification by what carries the tenant value. Counts are files and reconcile to 208:

| Carrier | Files | What supplies the organization |
|---|---:|---|
| None — pass-through write layer | 107 | A function parameter. These helpers resolve no tenancy and faithfully write whatever null a caller hands them |
| Request session | 47 | The session's active organization, through the three resolvers |
| Workflow argument or schedule | 29 | A payload field; schedule payload types declare it nullable |
| Offline — seeds and scripts | 14 | A hard-coded or script-supplied value; runs outside any request |
| Linked record or inbound callback | 6 | Derived from the record the callback is about; both the channel and the project fallback may be null |
| Agent runtime and other services | 4 | Varies by service; not request-scoped |
| Issued key or REST flag | 1 | The versioned REST resolver, driven by the query flag |
| **Total** | **208** | |

`[source]` throughout. The key-authenticated protocol surfaces do not appear as direct writers — they reach the shared write layer through procedures — but they still supply tenancy, and both supply personal.

**Consequence.** A request already in flight, a session cached in a signed cookie, an API key issued months ago, a webhook fired externally, a registered schedule, or a workflow already started can each produce a personal-context row *after* that user's rows have moved. `[inferred]` A scan taken inside that window can come back clean while the retired mode is still writable — so a clean scan is evidence about a moment, not about a state, and neither completion nor rollback can be demonstrated from it. This cost lands on every disposition at once and cannot be paid per item.

**What would have to be true for the mode to be non-writable** — stated as conditions, not as work:

1. No resolver on any path yields a null, undefined, or empty organization for an authenticated caller — across all three resolvers plus the two protocol surfaces that supply the value without consulting them.
2. No credential in circulation can *only* resolve to personal. The personal API key model has no organization column at all, so every already-issued key is structurally incapable of naming one. `[source]`
3. No session in flight still carries a null active organization — including the signed cookie cache, trusted for up to five minutes without a database read. `[source]`
4. No registered schedule and no already-started workflow still holds a null organization in its payload, and none can be replayed with one.
5. No linked record a webhook derives tenancy from still resolves to a null organization.
6. The project-guest write carve-out no longer presents a personal workspace inside a host organization.
7. **No destination organization can gain a second member while its rows are still moving.** Three paths create a membership row — organization creation, invitation acceptance, and an owner adding someone directly — and the interface can issue an invitation as soon as an organization id exists. `[source]` Nothing in the elimination freezes them, so a destination provisioned before its migration commits can be multi-member at cut-over, and the zero-exposure claim below rests on this condition rather than on the destination being private by nature.

Until all six hold simultaneously, a clean scan proves only that no personal row existed at scan time.

### H5 A restorable archive is one step beyond the retention precedent

**The precedent.** Removed attachments are hidden, then purged by a scheduled job after a tenant-configurable window whose approved default is **ninety days**, with a **seven-day grace period** so a mistyped window stays recoverable. `[source]`

That buys the number, the shape of a configurable window, the grace period, and a working enforcement path. What it does not buy is the word *restorable*: the codebase states in three separate places that this precedent ends in irreversible deletion **with no restore surface**. `[source]`

**Disposition affected:** `remove`.

**Consequence.** A `remove` disposition promising the data can be brought back asks for a capability that has never been built here, and should be priced as new rather than as reuse. `[inferred]` Three gaps make this a decision rather than a detail:

1. **A restorable claim cannot rest on backup practice.** The retention policy carries an open item recording that the managed database's backup, point-in-time-recovery and disposal schedule have never been attested, and the backup policy separately records — as its highest-priority open item — that **no restore test has ever been performed**. `[source]` So "the backups have it" is not available as an answer. If `remove` is approved on the strength of restorability, that restorability must be demonstrated by something built for the purpose, and the demonstration is part of the cost.
2. **An archive is a new data category.** Engineering carries a standing duty that every new category declares a retention period and a disposal path, and the same policy records that no organization-wide schedule enumerating categories exists yet. `[source]` Approving `remove` therefore *creates* that obligation rather than discharging it.
3. **Who may read the archive is a product input.** Access is granted on least privilege. The archive would hold rows that were private to exactly one user, retired into a world where organization roles now apply. "The originating user only", "organization owners" and "platform operators" are three different approvals with three different exposure profiles, and the disposition is under-specified until one is picked. `[source]`

### Internal references

*These paths are not in this repository — the compliance tree was cut when it was sanitised for open-source handoff. They resolve in the internal tree, and are listed here rather than cited above.*

- `docs/compliance/soc2/policies/data-retention-and-disposal-policy.md` — the attachment retention default and grace period; the open items on unattested managed-database backup and on the absent organization-wide schedule; the engineering duty on new data categories.
- `docs/compliance/soc2/policies/backup-policy.md` — the open item recording that no restore test has been performed.
- `docs/compliance/soc2/policies/access-control-policy.md` — least privilege.

---

## Invariant artifacts to narrow — engineering follow-on

> **Engineering owns this section.** Nothing here is a product-owner approval item. The dispositions above decide *what happens to personal context*; this decides *what the repository still says about it afterwards*.

This repository already learned this lesson and wrote it down. Three clauses of `docs/solutions/architecture-patterns/reversing-a-safety-invariant-narrow-it-do-not-delete-it.md` govern this section directly:

> *"Deleting one is silent: nothing fails, and the next reader finds a codebase that no longer explains why it is shaped the way it is."*
> *"Update every artifact that asserts the old guarantee, including the ones that still pass. A green test asserting a stale blanket rule is worse than no test."*
> *"An unexplained absence reads as an oversight and gets 'fixed' by the next reader; a named exclusion reads as a decision."*

"Every feature must support both personal and organization contexts" is a load-bearing invariant asserted in architecture guidance, contributor rules, an accepted decision record, compliance policy, public product documentation, inline schema comments, and CI gates. **The action on each is narrow, never delete** — rewrite it to say which half still holds and name the excluded half. A deleted assertion leaves a codebase whose shape has no explanation, and the next contributor restores the personal branch because nothing told them it was retired.

### Artifact register

| Artifact | The assertion | Narrowing action + reason |
|---|---|---|
| Architecture guidance, core rule | *"Every feature MUST support both personal and organization contexts with strict data isolation."* | Rewrite to state organization context as the only supported tenancy and name personal as retired. **Keep** the exclusive-filter block, rescoped. *This is the sentence every other artifact cites or paraphrases; leaving it makes the retirement look accidental* |
| Same document, two checklists and one summary line | *"Test both contexts (personal AND organization)"* etc. | Same narrowing at all three sites. *The checklists are what a contributor actually reads; a narrowed headline with un-narrowed checklists still instructs people to build the retired context* |
| The agent-instruction file at repository root | The same rule restated | Narrow to match. *This file is loaded into every agent session here, so a stale copy re-teaches the retired rule on every task* |
| Contributor rules | *"Every feature **must** support both personal and organization contexts with strict data isolation."* | Narrow to organization-only, keeping the link to the public guide |
| Contributor feature checklist and the pull-request template | *"Queries use XOR pattern (never OR)"* / *"Tested in both personal and organization contexts"* | **Split them.** Drop the both-contexts item; **retain** the exclusive-filter item rescoped. *The "never OR" half survives untouched — deleting it alongside the personal half would retire a rule that is still true* |
| The accepted decision record on tenant isolation | *"Every query must explicitly handle both personal and org contexts"* | **Do not edit the body.** Requires a superseding record — see below. *The documentation standard makes accepted records immutable; editing in place violates the repository's own rule* |
| Compliance access-control policy, scope and one policy statement | Names personal context as a stated control boundary, and describes what an explicit null means | Narrow the scope bullet to organization-to-organization isolation and add a dated line recording the retirement, so the control's history stays auditable. **Keep** the no-session-fallback guarantee verbatim — that half is the actual anti-leak control and is unaffected. *Silently dropping a boundary from a policy's scope is an evidence gap, not a cleanup* |
| Three sibling compliance policies restating the boundary | Variations on *"both personal and organization tenant contexts"* | Narrow each in the same pass. *The learning's third clause admits no "too minor to update" exception* |
| Public product documentation on tenant isolation | *"every feature supports both personal and organization contexts"*, plus a boundary table, a diagram, and a section describing the personal workspace as *"your private workspace"* | Rewrite for organization-only tenancy. *This is the one artifact whose staleness is a **product claim**, not an internal inconsistency* |
| Inline schema tenant comments, ~28 sites | *"Tenant isolation (strict XOR: either userId OR organizationId)"* and variants | Rewrite the class of comment once and apply across the sites. *The precedent case's schema comment was what made the old boundary legible; leaving 28 copies asserting a retired rule is the same silent-deletion failure at scale* |
| Query-layer class doc-comments | *"These tables can belong to either a user OR an organization, never both"*; *"Tables that are organization-only (no personal equivalent)"* | Narrow each to its surviving branch; where a personal branch is retained for legacy rows, say so. *This file **is** the exclusive-filter rule in executable form — its comments are the only place the taxonomy is explained* |
| The tenant-type union and its two helpers | A three-member union including a personal member | Narrow the union, or keep the member with a comment naming it legacy-only. **Do not remove it without a comment recording why.** *An unexplained absence in a three-member union reads as an oversight and gets re-added* |
| The primary resolver's precedence doc-block | Two of five precedence items describe personal context | Rewrite those two; **keep** the other three and the closing security invariant. *This doc-block is cited by name in the compliance policy — the two must be narrowed together or the policy cites a comment that no longer says what it quotes* |
| Generated row-level policy templates | A null-organization test repeated across every policy shape | Decide once whether the personal arm is removed or retained for legacy rows, apply to every template, and record the decision in the file header. *Leaving them while the application stops emitting the personal type yields policies that are dead code asserting a live rule* |
| The testing standard's fixture factory | A factory default of a null organization | Change the default. *This is the template every new fixture is copied from — it silently makes personal the default tenancy of all new tests* |
| An agent skill's integration checklist | *"Test in both personal AND organization contexts"* | Narrow. *A skill re-injects the retired rule into every future integration task, which is a worse propagation path than a document nobody opens* |

All rows `[source]`.

### The tests, split in two

The two populations need different handling, and conflating them is how the failure mode hides.

**Population A — ordinary coverage that follows the code.**

**Derivation:** `grep -rlE 'organizationId: null|type: "personal"' --include='*.test.ts' --include='*.test.tsx' --include='*.spec.ts' . | grep -v node_modules | wc -l` → **586 files** `[source]`. One matching file contains a byte sequence that makes grep treat it as binary, so the same command with `-a` returns 587 — a reminder that a printed command reproduces a number only under the shell it was written in.

These files *exercise* personal context — seed a fixture, call a handler, assert a result. They assert **behaviour**, not the rule. When production code drops its personal branch they change or delete as a mechanical consequence, caught by the compiler and by red tests. **They need no separate disposition, and enumerating 586 files would bury the three that matter.** The count is measured; the characterization is `[inferred]`.

**Population B — artifacts that assert the rule itself.** Enumerated individually because they can keep passing while meaning something different — precisely *"the ones that still pass."*

| Artifact | What it asserts | Narrowing action + reason |
|---|---|---|
| `packages/database/__tests__/rls-isolation.test.ts` | Drives the personal tenant type directly against live policies, with cases asserting personal reads succeed and cross-context reads fail | **Keep the file.** Rescope the personal blocks to whatever the retained policy arms still guarantee, and replace deleted cases with a named, commented exclusion rather than a silent removal. *These are the only executable proof that the personal policy arms behave as written* |
| `packages/database/__tests__/rls-coverage.test.ts` | The coverage guard: every organization-scoped tenant table is covered or explicitly exempted, and the allowlist matches real tables | **Keep the guard** — its organization-scoped assertion is *strengthened* by the migration. Update its header and parity assertions to name which templates survive. *A guard whose stated purpose references a two-context world reads as stale and gets weakened by the next person who touches it* |
| `scripts/tenant-isolation-check.ts`, wired at `.github/workflows/unit-tests.yml` as a hard gate on every pull request | A blocked pattern written against the personal-context idiom: it fails builds that query a tenant table without explicitly coercing to null | Rewrite the doc-block, the pattern comment, and the failure message to state what the gate still guards. If the surviving concern is "a re-introduced personal branch must fail the build", invert the pattern. **Do not delete the gate.** *See below* |

All rows `[source]`.

**Why the split matters.** Population A fails loudly when the code changes — that is what coverage is for. Population B does not. The CI gate is the exact shape the learning warns about: it exists to force the personal branch to be *written explicitly* rather than fall through. After an organization-only migration that coercion no longer names a tenant context at all, yet every line still matches, the gate still passes, and CI stays green. Nothing fails; the guarantee quietly changes meaning under a name nobody re-reads. `[inferred]` **Structural gates are where a retired invariant hides longest, because passing is exactly what they are supposed to do.**

### The decision record is a special case

The tenant-isolation decision record carries `Status: Accepted`, and the documentation standard governs its directory: *"Numbered, immutable once accepted."* `[source]` Its body therefore **may not be edited in place**, including the consequence line requiring every query to handle both contexts.

The eventual change requires a **new superseding record as a first-class deliverable.** The next free number is **018**. `[source]` It must follow the mandated format, state which half of the original survives (exclusive filtering, no OR patterns, no session fallback) and which is retired, and be referenced from the narrowed architecture guidance and compliance text so the pointer is discoverable from what people actually read. The only permitted edit to the original is its status line moving to deprecated with a pointer to the successor.

**This document does not draft that record.** Drafting it here would assert an architecture decision that has not been taken.

### Pre-existing drift — a named exclusion

The architecture guidance's tenancy-class table has already diverged from the query layer, independently of this initiative `[source]`:

- **A whole class is missing.** The table lists four categories; the code implements seven filter classes.
- **The strict-isolation row is wrong.** It names three models that in code belong to the per-user-within-org class — a different filter shape in organization context.
- **A documented exception is absent.** A project carve-out builds a filter the caller *ORs* into the tenant filter for the cross-organization guest read path, so guests can read project data *in addition to* their normal tenant context. The table presents "never OR" without it.

**Marked as a pre-existing exclusion.** This predates the initiative, is not caused by it, and would not be fixed by it. Folding it in would make the migration accountable for a correctness gap it did not create and obscure which edits were the tenancy change. It is named rather than left silent for the reason the learning gives. Whoever narrows the tenancy section will be looking straight at it, so the two are worth sequencing together even though they are separate changes.

### Internal references

*Not in this repository — the compliance tree was cut when it was sanitised. Cited here rather than in the body so a reader with access to the internal tree can find the source.*

- The compliance access-control, data-classification, data-retention, and secure-development policies under `docs/compliance/soc2/policies/` — each carries a scope or statement naming the personal-versus-organization boundary.
- The export prune rules that previously made the above internal-only lived under an open-source directory that no longer exists in this repository; publication is now decided outside it.

---

## Bounds — what this document does not cover

Each exclusion below is a decision, not an omission. An unexplained absence reads as an oversight and gets filled in by the next reader; a named exclusion reads as a choice.

- **Migration design.** Batching, ordering, transactionality, rollback procedure, and the archive's own schema are out of scope. This document prices dispositions; it does not propose mechanisms. The hazards section deliberately stops at "what would have to be true" rather than "how to make it true".
- **The branch-point cleanup.** Roughly three thousand personal-versus-organization branch points exist across the API, database, temporal, and AI packages. The ticket's acceptance criteria require personal context to become *unreachable*, not that the branches be deleted. Scoping a follow-on change against the branch count would be scoping against something the ticket does not ask for.
- **Any deployment whose configuration was not observed.** Findings that turn on a configuration key are marked with the key rather than resolved. Billing routes are the clearest case: the code path exists on both sides and renders on neither in the deployment observed.
- **Whether anything is actually there.** The drop proceeds on a team assessment that no active personal usage exists, with a verification pass explicitly decided against. This document establishes which categories personal scope carries; it counts nothing. That gap is recorded at PO-11 with its owner, not argued here.
- **Production data volumes.** No row counts, collision counts, or population sizes were measured. Several dispositions — notably the twelve uncompensated unique constraints — cannot be finally priced without them, and are marked as needing a count.
- **Pre-existing drift in the architecture guidance.** The tenancy-class table in the repository's architecture document has already diverged from the query layer independently of this initiative: it lists four classes where the code implements seven, its strict-isolation row names models that live in a different class, and it omits a documented exception to the exclusive-filter rule. This is a real defect and it is not this initiative's to fix — folding it in would make the migration accountable for a gap it did not create.
- **The superseding architecture decision record.** Eliminating personal tenancy supersedes an accepted, immutable decision record and will require a new one. That record fixes a decision this document exists to inform, so drafting it here would assert an outcome that has not been chosen.
- **Reproduction detail for open defects.** Two defects recorded here are unfixed at the time of writing. They are named by file and disposition, with enough context to schedule them and no more.

**Staleness.** `docs/solutions/workflow-issues/verify-inherited-scope-against-current-reality.md` records that a stated scope is a claim about a past tree. That applies to this document as much as to the ticket it audits. This is a snapshot: the tenancy column count moved from 147 to 187 over the sixty days before it was written. Every enumeration states the command that produced it precisely so a later reader can re-derive rather than trust — re-run them before acting on a count.

**And the precedent is not encouraging.** This repository has two prior documents of this shape. `docs/attachment-surface-map.md` is alive, cited, and backed by a continuous-integration drift test that fails when its claims stop matching the tree. `docs/TENANT_ISOLATION_AUDIT.md` was a hand-maintained document about tenant isolation with no such guard; it was deleted rather than revalidated. This document currently has the shape of the first and the defences of the second. A drift guard is deferred, not dismissed — see the plan's follow-up section.
