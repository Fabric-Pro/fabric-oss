# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Codebase knowledge

### KBase
A project's attached codebase treated as a knowledge source the AI Assistant can query — the user-facing name for "the code the assistant can read." A project has a KBase when a Repository Integration is connected, code search is enabled, and the Code Index is built; absent any of those, the assistant has no KBase to draw on.

### Repository Integration
A project's connection to a git repository (GitHub, GitLab, or Azure DevOps). Distinct from a one-off clone: it persists credentials and a health status, and is the thing the assistant, code indexing, and local-dev tooling all resolve a project's code through.

Carries a credential health status: active, credentials-expired (the token lapsed and auto-refresh failed — re-authentication required), errored, or disconnected (detached, its stored credentials wiped). A disconnected integration is functionally absent even though its row persists.

### Code Index
The built, searchable index of a connected repository's code that powers the assistant's code search. Separate from the Repository Integration: a repo can be connected while its index is missing, still building, stale, ready, or failed. "Ready" (or stale-but-usable) is the only state in which code search returns results.

### Codebase availability
The discriminated state describing whether — and if not, why not — the assistant can answer code questions for a project. Resolved from the Repository Integration status, the code-search toggle, and the Code Index status together, rather than a single attached/not-attached flag. Distinguishes not-connected, code-search-disabled, credentials-expired, not-yet-indexed, indexing-failed, and available, so the assistant reports the actual reason and the concrete next step instead of a blanket "no repository attached."

## AI surfaces

### Loom
The standalone agent workbench, distinct from the assistant embedded in a document. Carries its own history, agent picker, tool and MCP-server toggles, and frames.

Not a single chat: Loom runs in **Direct** and **Orchestrator** modes, and the two are distinct implementations rather than one shared surface. Both now accept document attachments (Excel, PDF, DOCX, and the rest of the shared chat allowlist) alongside images — Direct through its single attachment queue, Orchestrator through two queues (images feed the multimodal-vision path; documents feed RAG plus inline extracted text). Treating "Loom" as one surface when reasoning about attachment behavior still produces wrong scope — always name the mode.

### Attached file
A file the user supplied in the current turn, as opposed to a chunk the knowledge base returned.

All three surfaces deliver an attached file's full text **inline** — injected into the prompt, so the model has already read every word and must not be told to "open" or "see" it. Nexus and Loom Direct used to upload and extract the same file and then discard the extracted text, leaving its content to reach the model only if similarity retrieval happened to surface a chunk of it. That is no longer true, and reasoning from it now produces wrong scope in the opposite direction.

Inline is **additive to retrieval, never a replacement**. Both run: inline gives completeness on a file small enough to deliver whole, retrieval gives relevance on one that is not — and a file cut by the character budget is exactly the case where retrieval earns its keep. A surface that dropped retrieval on the grounds that it "has the text now" would lose the tail of every large document.

The text is bounded by the Character budget before it reaches the prompt, and travels wrapped in an Attachment envelope.

### Dedicated attachment
A file attached to a work item, stored as its own record rather than inside the item's description. Not an Attached file: that one belongs to a chat turn, this one belongs to the ticket and outlives every conversation about it.

Each carries a **designation** — `LOCKED` ("Asset (protected)") or `UNLOCKED` ("Context only"). The word does two unrelated jobs, and conflating them is the usual source of wrong scope: it decides whether the file can be deleted, *and* it decides whether the AI may read it. So a file cannot currently be both protected from removal and readable by the model, and flipping one intent silently flips the other.

The two upload paths default differently, and the split is deliberate. The create-story dialog opens at Context only — material attached while writing a ticket is mostly reference. The story-detail panel defaults to Asset and offers Context only as a per-upload opt-in, because by the time a ticket exists the panel is also where finished artifacts land, and Asset is the designation that protects them from deletion.

Context only is a permission, not a promise: it means *the model may read this*, not *the model did*. Only text-bearing formats are extracted and delivered — TXT, MD, CSV, DOCX, PDF. A context-only image or video is still never read, which is why the attachment panel labels those rows explicitly rather than leaving the user to assume.

### Attachment envelope
The delimited wrapper around one attached file's text as it reaches the model — a tag pair enclosing the filename and the extracted content.

It exists to make the boundary between the prompt's own structure and a file's content unforgeable. A file's text is untrusted: without a delimiter the model cannot tell a heading the prompt wrote from an identical heading a document contained, and a document that reproduces the surrounding scaffolding can invent a whole attachment section the model is instructed to trust. Occurrences of the delimiter inside the content are therefore mangled rather than deleted — deleting the inner tag of a nested forgery reassembles a live one.

Exactly one builder constructs it, for every surface and for the server-side producer alike. That is a security property, not tidiness: duplication is acceptable for state and rendering, but a guard applied to one copy and not another is a silent hole, and the copy that gets missed is the one nobody remembers exists.

### Character budget
The ceiling on how much of a file's text is handed to the model in one turn, applied on the chat path and deliberately nowhere else.

Knowledge-base ingestion of the same file stays unbounded on purpose, and the asymmetry is the point: chat text goes into a prompt, where overflow is the failure; ingestion text goes to chunking and embedding, where truncation is the failure — a document cut mid-ingest embeds its own truncation marker into the vector store as though it were content. So the bound belongs with the caller that builds a prompt, never inside the shared readers those two paths have in common.

When it truncates, both the model's copy and the user's view have to say so. The copy carries a marker naming what was omitted, or the model reports an omitted line as absent from the document rather than as unread.

## Uploads

### Upload surface
One place a file enters the product, taken as a whole: the picker a person uses, the procedures behind it, and the vocabulary of formats it accepts. The product has several, and they are deliberately not interchangeable — each admits a different set of formats for its own reasons, and each owns its own gate.

Surfaces are the unit that questions about file support have to be scoped to. "Is this format supported?" has no product-wide answer, only a per-surface one, and a finding that omits the surface reads as an all-clear it did not establish. A format working on one surface says nothing about the next.

### Format vocabulary
A single upload surface's authoritative list of the formats it accepts, together with everything derived from it — what its picker advertises, what its gate admits, and the format names its error messages quote.

The derivation is the point, not the list. A surface that restates its formats anywhere — a second array, a hand-written accept string, a hardcoded message — has two lists that agree until someone edits one, and the failure is silent in both directions: a picker offering a format its gate refuses, or a gate admitting one the picker never showed. Vocabularies are per [[Upload surface]] by design, but they compose from one shared resolver rather than each implementing their own.

Where surfaces overlap they share a core and name their own additions, rather than merging into one list — merging would hand every surface the formats only one of them wanted. The drift a core prevents is the kind no per-surface check can see: two vocabularies each internally consistent and collectively disagreeing, so a format is uploadable in one place and refused in another although one reader serves both.

A vocabulary answers *which* formats, never *how a file is identified as one of them* — that is [[Declared type]] versus resolved type, and conflating the two is what makes a format look unsupported when it is merely unrecognised.

### Declared type
The media type a client claims a file has, as opposed to the one the product resolves for it. A claim, not a fact: browsers fill it from the operating system's own registration, so a file whose extension the OS does not know arrives with the claim empty, and a caller reaching a procedure directly can claim anything.

Resolution prefers a declared type the surface's [[Format vocabulary]] recognises, and otherwise falls back to the filename extension — also caller-controlled, but the two disagreeing is what makes an unregistered extension recoverable. It fails closed: neither recognised means refused, except where the extension is a [[Forced type]].

Resolving is not gating. A surface's resolver may be required to return the caller's own value when nothing resolves — where the product normalizes without refusing — so a caller that tests the resolved value for emptiness has no gate at all. Refusal is a separate lookup of the resolved type in the vocabulary.

### Forced type
An extension whose canonical media type is resolved ahead of whatever the client declared, because the declaration is wrong or absent often enough that believing it routes the file to the wrong reader.

Forcing does three jobs at once, which is why it is one mechanism and not three: it rescues a file the operating system gave no type, it collapses alias spellings onto the one media type the readers match on, and it overrides a declaration that would route the file wrongly. It is derived from the [[Format vocabulary]] rather than listed separately — a format added to a vocabulary without reaching its forced list is advertised and then refused for exactly the untyped and alias-typed uploads forcing exists to rescue. Forcing an extension whose family overlaps another format's is what keeps the narrower one from being captured by the wider.

## Monitored conversations

### Linked conversation
A chat or channel from an external messaging system attached to a project as context. The attachment is a **pointer, not a copy**: it records which conversation to watch and how far it has been read, and nothing about the messages themselves.

This is the distinction that misleads people most often, because a linked conversation appears in the project's context list beside items that do hold their content. Reading one means going out to the source system or to what a [[Conversation bundle]] captured — never to the pointer itself. Only shared channels are eligible to be captured; a one-to-one or group chat can be linked and watched, but its messages are never stored, so it reports where its content lives rather than pretending to hold it.

### Conversation bundle
One analyzed batch of messages from a linked conversation, stored as its own record beneath that conversation's pointer. A conversation accumulates bundles over time; each is written once and never rewritten, so together they partition the conversation rather than overlapping it.

Two rules make bundles behave under concurrency and failure. Identity is claimed per message before a bundle is written, in the same transaction, so two workers reading the same conversation at once end up with disjoint message sets and a retry re-wins exactly what it lost — a bundle can never be silently duplicated or dropped. And a bundle is embedded under a *lease* held while the work is in flight, which is deliberately not the same record as the mark saying embedding finished: a worker that dies mid-embed leaves the lease to expire and the row reclaimable, where writing the completion mark up front would have hidden it from recovery forever.

## Living documents

### Auto-Refresh
A project document's enrollment in a scheduled AI update cycle. Opt-in per document (never on by default), with a cadence set per document — never inherited from the project. An enrolled document is picked up by an hourly sweep once its cadence has elapsed; the sweep stands down rather than acting when the document is locked, was edited within the hour, or the person who enabled it has lost access to the project.

### Refresh Proposal
The candidate update an Auto-Refresh cycle produced, stored against the document rather than written into it. This is the default outcome: the AI proposes and a human accepts or rejects. Applying a proposal re-checks the document version it was generated from, so a proposal overtaken by a human edit is refused rather than applied blind.

Direct writing exists as a separate per-document opt-in (auto-apply, off by default). A cycle that produced a proposal is *complete* — the cadence clock advances — so an unaccepted proposal does not cause the document to be regenerated on a loop.

### Refresh Agent
The non-human author identity that AI-written document versions are attributed to. Deliberately distinct and recognizable, not a generic system label: version history must never let an AI rewrite be mistaken for a person's edit, or a person's edit be mistaken for the agent's.

It is one of several such identities rather than the only one — any automated writer that touches document content needs its own. An automated identity the authorship resolver does not recognise is rendered as an unknown user, which the product reads as a deleted account, so an unregistered writer does not merely go unnamed: version history actively reports it as a person who is gone.

### Imported document
A project document whose body is material a person supplied — pasted or uploaded — rather than text the AI produced. Not a lesser document afterwards: it is versioned, editable, and eligible for every later AI action, including enrolment in Auto-Refresh.

It keeps a link back to the source it came from, and that link has a visible consequence: a source that became a document is no longer listed as loose project context, because it is not a separate thing to reason about any more. Regeneration is where the distinction bites — rewriting one discards the words the person supplied, so it is confirmed differently from regenerating something the AI wrote in the first place.

### Active document
The one document of a given type that the project treats as current. Only an active document is embedded for retrieval, so activeness is what decides whether a document can influence future generation rather than merely sit in a list.

At most one per type is the invariant the whole idea rests on: two active documents of one type put contradicting sources in front of every later run, and neither is marked as the loser. Creating a document of a type that already has an active one therefore produces an inactive one, and promoting it is a separate, deliberate act.

### Source usage
How supplied material is meant to be used at the moment a document is created: as background the AI writes *from*, or as the document body itself, published unchanged.

The two differ in what survives. Used as background, the material is kept as project context and stays available to later generations, and the AI is free to ignore its wording entirely. Used as the body, the words are the document, nothing is generated, and the material is not added to the retrieval corpus a second time — the document already is it.

## Capability gates

### Rollout gate
The switch that decides whether a capability is available at all — whether its controls render and whether its write paths accept a request. Off means the capability is absent rather than present-and-failing: a surface that renders against a rollout gate its own backend does not honour is the shape of an outage, not of a disabled feature.

### Kill switch
The switch that stops work already in motion, distinct from the Rollout gate and never a synonym for it. It is armed in every environment by design, because its value is that it is available in an incident; it is read again immediately before an unattended write rather than only when the work was scheduled, so flipping it stops a run already under way.

Two consequences follow from what it is for. It reads fail-closed: a switch whose stored state cannot be read resolves to stopped, because the moment its store is faulting is the moment someone is most likely to be reaching for it. And it cannot authorise work on its own — an unattended writer requires its Rollout gate as well, or a capability nobody can see or reach would still be acting on their documents.

## Workspace context

### Workspace
The organization a person is working in. **Workspace** is the user-facing word and **organization** the internal one; they name the same thing, and the surrounding code uses whichever its layer historically used. Prefer *workspace* in anything a user reads.

Every account belongs to one. There is no longer a personal context to work in, so an absent workspace is a failure to resolve one rather than a place someone can be — code that finds itself without one should treat that as a bug, not as a mode.

### Last-active workspace
The durable, per-user record of the workspace someone was last working in. It is not a cache: it is the only thing that remembers where a person works between sessions, and losing it is unrecoverable rather than merely inconvenient.

It decides more than where a sign-in lands. A fresh session is given a workspace by consulting it, so a credential with no workspace of its own — an API key, a protocol client — resolves through it too. A write lost in the background therefore moves a person's next sign-in *and* the tenant their non-browser credentials operate in, with nothing anywhere to explain either.

Distinct from the **active workspace** carried on a session, which is one last-write-wins value shared by every browser tab on that session and can outlive several switches. When the two disagree, the last-active record is the honest one.

### Ambiguous resolution
The answer a workspace resolver gives when a person belongs to several and nothing authorised names one of them. It is deliberately distinct from *belongs nowhere*: the first is answerable by the caller naming a workspace, the second is not, and collapsing them turns one into a lockout and the other into a lie.

An ambiguous answer is a refusal, not a default. A caller that converts it into "the first one" has undone the refusal — and where that list has no defined order, has done so unpredictably.

## AI access

### BYOK
"Bring your own key": the access model in which a **user-facing** AI operation runs on a provider the tenant configured, and on nothing else. Not a billing arrangement — no allowance, no card, no platform credential stands behind such a request, so a tenant without a configured provider is refused as *not configured* rather than as *out of credit* or *needing a card*.

BYOK is enforced by which resolver a caller reaches, not by a flag it passes. Two named pairs exist: a tenant-facing resolver that cannot reach the platform's own gateway key at all, and a system one that can. An untouched caller therefore stays on the tenant half by default, and the two cannot be passed the wrong way round.

The boundary is **whether a person is waiting**, not what kind of operation it is. Background work keeps the platform key so a keyless tenant's uploads still index; anything a person triggered refuses until they configure a provider. The distinction is easy to misapply, because the same *kind* of work falls on both sides: embedding a document during ingestion is background, while embedding a chat message to retrieve context for a reply is not. Reading the rule by its category rather than its reason is how a waiting user ends up on the platform's key.

A member's own key counts — it resolves inside an organization that has none.

## Feature specs

### Clean Spec
A feature's specification as one markdown document, assembled from the two columns it is
stored in — the narrative body and the acceptance criteria — and split back apart on save.
The boundary between them is carried by an `Acceptance Criteria` heading inside the text
itself, not by any separate marker, so the split is only ever as reliable as that heading.
Anything that alters the heading line — a rename, a demotion to a lower level, or inline
decoration applied in the editor — can move or lose the boundary.

Every acceptance heading is dropped on the way in and exactly one is re-emitted on the way
out. That is what lets a document which somehow acquired two of them collapse back to one,
and it is why a stray heading must never be left inside the criteria: the readers that
count criteria stop at the first heading they meet.

### Feature maturation
The staged process a feature moves through before it is ready to build, worked in three
views: an AI summary with the open questions it still has, a log of decisions answering
them, and the Clean Spec those decisions are folded into. Maturation is what turns a rough
request into a specification; a feature can be edited outside it, but the decision trail
only exists for features that went through it.

### Pending-integration appendix
A transient block appended to the end of a Clean Spec holding decisions the product owner
has answered but no AI run has yet folded into the body. It is written deterministically
when a question is answered, and the next maturation run is instructed to dissolve each
entry into the appropriate section and then delete the block.

It is also the only channel by which a later run learns those decisions. The agent serving
a run receives the prompt, retrieved context and the spec text — it holds no database
access — and the clause teaching it to integrate them is conditional on the block's exact
heading. So an appendix that is lost, or restored without that heading, does not delay a
decision; it strands it, because nothing on the refresh path reads the decision log.

Absence of the block is treated as proof of integration. Nothing verifies that a run which
deleted it actually moved the content into the body.

### Do Not Modify section
A section of a spec whose body is the reporter's own words, which AI rewrites must return
untouched. Enforced rather than merely requested: the body is extracted before a rewrite
and spliced back afterwards if the model altered it.

The guard is located by matching the section's heading, so it fails **open** — if the
heading cannot be found, nothing is preserved and the rewrite is accepted silently. Any
change to how that heading is matched is a data-integrity change, not a formatting one.

## Prompt routing

### Work item kind
A work item is either a feature or a bug, and nothing else — the third, legacy type was
retired and its rows migrated to feature. The kind is not merely a label: it selects which
prompt every AI action writing that item's body runs, so changing it changes what the next
generation produces.

Kind is a property of the stored row, and the row is the only authority on it. A caller that
names a kind — a browser holding a cached copy, a request that passes one as an argument — is
stating a claim, not a fact, and a template chosen from that claim is a parallel copy of the
routing rule that drifts the moment the two disagree.

Converting an item's kind rewrites its body through the new kind's template, as part of the
conversion and without a separate approval. This supersedes the earlier rule — that a conversion
deliberately left the body alone and the new kind governed only the *next* AI action — which was
reversed under Fizzy #2048 because an item whose type had changed still read in the old type's
shape. The half of that rule which still holds: nothing **already generated** is marked stale, so
a converted item keeps its pre-conversion QA analysis and maturation digest.

The section-signature rules of the destructive-rewrite guard must not run on a conversion or a
mixed-type merge refresh — a cross-type rewrite drops every section of the source type by design,
so those rules would refuse it every time; the guard's kind-agnostic rules (empty or collapsed
output) do still apply, and are the only floor under an unreviewed rewrite.

### Prompt binding
The record tying an agent name and document type to a prompt version, optionally scoped to one
work item kind. A null kind scope means the binding serves both kinds; feature or bug means it
serves only that one.

Resolution is exact-match and never falls back across kinds — a missing bug binding does not
quietly resolve the feature prompt. That is a safety property, not a limitation: the failure it
prevents is a bug body silently rewritten to feature shape, and callers are expected to hold
rather than substitute when a binding is absent. Bindings also resolve per tenant, so an
organization's override shadows the system default without either leaking to the other.

A prompt that lives as a literal in code has no binding, cannot be edited by an administrator,
and is invisible to this resolution — which is why a ticket skeleton written in code is a
routing gap even when its text happens to be right.

### Prompt retirement
A recorded decision that a system prompt key must not come back. Deleting a SYSTEM-scope prompt
writes the key down, and every path that creates one — both seed catalogues and the product's own
create endpoint — refuses that key afterwards. Without the record the deletion is undone by the
next catalogue run, which recreates the prompt under its seed name rather than the name it was
renamed to when it was marked dead.

Retirement is a veto on the **key**, not on a row. Duplicate SYSTEM rows may share a key and
resolution takes the first match, so deleting one row while its twin survives is a deletion that
is reported, recorded and ineffective — which is why the deletion removes every SYSTEM row
carrying the key at once.

The veto does not reach other scopes. An organization may still create its own prompt under a
retired key, and a fork an organization made of the retired prompt survives its parent. That is
deliberate: a platform action does not remove a tenant's data. "This key is retired" therefore
means the platform will not serve it again, not that nobody anywhere can use it.

## Reports

### Report Template Instance
A user's configured, runnable report — a report template bound to specific data sources, parameters, and an optional schedule. Scoped to a single user or an organization, never to a project, so access is resolved through ownership or organization membership rather than project membership.

### Report Execution
A single run of a Report Template Instance. Status lifecycle: Pending, Running, Completed, Failed, Cancelled.

Cancellation is a sticky terminal state — once a user cancels a run, Cancelled wins: the run's own later status writes no longer override it, and the run stops itself rather than relying only on being externally terminated. A run may be cancelled by its owner, or by an admin/owner of its organization, and the cancelling actor is recorded separately from the run's owner. A cancelled run leaves no report output.

## Build updates

Unrelated to Auto-Refresh, despite both being "the app updates itself." Auto-Refresh regenerates a document's *content*; the concepts here reload the *page* onto a newer deployment. Conflating them produces wrong scope.

### Reload Seam
A moment in a session where a full page reload costs the user nothing, so a stale build can be swapped for the current one with no UI at all: an internal link click, a pathname change, or returning to the tab after being away long enough. Reload Seams are the primary update path — the intended experience is that a user never learns a deploy happened.

Qualified deliberately: bare "seam" is already in use across specs in the Michael-Feathers testing sense (a place to substitute behavior under test). The two are unrelated.

### Backstop banner
The countdown banner that appears only when a user has stayed on one screen long past the stale threshold without hitting a single Reload Seam, and would otherwise be stranded on old code. It is the exception, not the update mechanism — reasoning about it as the normal way users receive updates inverts the design.

Because it fires only on a parked user, it always lands on someone mid-task, and almost always on someone scrolled away from the top of the page. That is why it is sticky rather than static: it is the only warning before a forced reload, so a placement that can scroll out of view defeats its whole purpose.

## Onboarding

### Get started
The in-app orientation experience as a whole, not a single screen: a contextual drawer listing every area and component, a guided spotlight tour across the app, per-page detailed tours, and one-off "show me" highlights. Reached from a persistent launcher in the sidebar's account utilities, and gated as a unit by one kill switch — disabling it removes every surface at once, so there is no way to retire one piece independently.

### Onboarding tour status
A user's engagement with the guided tour, as one of: not started, in progress, completed, or dismissed. It leaves "not started" only through a deliberate act — starting, finishing, or dismissing the tour — which makes "still not started" the durable definition of a user who has never engaged, and the basis every onboarding nudge targets.

Distinct from whether a user has *seen* a surface: closing the welcome drawer without starting the tour leaves the status untouched.

### Auto-launch cohort
Accounts created on or after the instant the guided tour shipped. Only this cohort gets the one-shot welcome drawer on first login; accounts predating it are never interrupted, on the reasoning that a user should not be ambushed by a feature that arrived after they joined. The cohort boundary is a fixed instant, not a rolling window, so it narrows over time rather than moving.

The exclusion is why nudges toward the tour deliberately do *not* reuse this cohort: the users with no signal at all are precisely the ones outside it.

### Page tour
A short walkthrough of one project page's own in-page components, distinct from the guided tour that crosses the whole app. Auto-opens once per covered page for the auto-launch cohort, and once for everyone when the page itself is newer than the onboarding baseline — a new page announces itself to existing users. Dismissing an auto-opened one opts the user out of all further auto-opens, while a manually started one does not.

### Get started pointer
The affordance that marks the Get started launcher for users whose onboarding tour status is still "not started": a callout shown at most once per browser tab session, plus a quiet static marker on the launcher icon that persists until the user engages or dismisses it. Suppression is permanent and per-user rather than per-device.

Yields to every other onboarding surface, so it never stacks on top of the welcome drawer or a tour — for a brand-new account it is therefore a second-session affordance by design.

## Navigation

### Project shortcut
A quick-access entry beneath the Projects navigation item, pointing straight at one project. The list is per-user and capped at a fixed count (three), and it is composed rather than chosen: favorited projects fill the top slots and the remainder is filled by the most recently visited projects the user has not favorited. The two never appear as separate modes — a user with one favorite still sees a full list.

Ordering inside the favorited group is by recency of visit, with never-visited favorites last. A project is eligible only while it is reachable by that user and neither draft, archived, nor deleted, so a shortcut disappears on its own when any of those stop being true.

Resolution is per tenant, and deliberately not exclusive for guests: someone whose only access is a shared project is presented the personal workspace, and their shortcuts resolve there and link into the project's own organization. Reading the list is a display concern; it never grants access.

### Project visit
A per-user marker that a person opened a project — one overwritten timestamp per user-project pair, **not** a history of opens. There is no visit log and no count; the previous value is simply replaced, and only the most recent one exists.

Recorded whenever the person opens a project's main view, independently of whether any surface that reads it is switched on, so the data is already meaningful the first time a reader is enabled. A write never moves the marker backwards, so two views racing from different places settle on the later one. Retention is the lifetime of the user and the project — deleting either removes it, and nothing expires it sooner.

Distinct from the recent-project list the orchestrator keeps for session continuity: that one records what an agent run was pointed at, this one records what a person navigated to. Treating them as interchangeable produces a list the user never built.

## Flagged ambiguities

- "Feature flag" had been used for both the Rollout gate and the Kill switch — these are distinct, and a capability can need one of each. Merging them turns an always-armed brake into a switch that launches the feature.

*Source usage* and an attachment's *designation* are different axes and must not be
described in each other's words. Designation decides whether a file is protected from
deletion and whether the model may read it; source usage decides whether supplied
material feeds a generation or becomes a document body. Both are two-valued and both
say "context" in one of their values, which is exactly why conflating them is easy —
and why a change to one has never implied a change to the other.
