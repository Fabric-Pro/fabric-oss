# fabric-app

## 1.14.0

### Minor Changes

- 42c7975: Import GitLab attachments back into Fabric, completing bidirectional attachment sync

### Patch Changes

- 4a0e7b8: Let a project reach chat-channel setup from the settings cards that select channels, including when channels are already linked.
- 42c7975: Decision ownership now rejects non-members, survives version reverts safely, and stops re-notifying the owner on every save.
- 42c7975: Decisions can now be tagged with a type from a per-project AI-recommended taxonomy, an accountable owner, a long-standing/short-term duration, and a Priority flag that feeds roadmap prioritization.
- 42c7975: Re-drafting test cases no longer duplicates cases when the model spells the same criterion differently
- 42c7975: AI-drafted test cases now link to the acceptance criteria they validate
- ad9cddd: Stop Direct chat dropping whole MCP servers from the model's tool list while still showing them as connected
- 42c7975: Prompt tags become one green-filled pill everywhere, and default badges are outlined and coloured by tier.
- 42c7975: Tidy the Temporal payload-bounding helpers after three-lens review
- b42e34e: New project members now appear in an enabled newsletter's recipient list as soon as they join, instead of only after the next send or a disable/re-enable toggle.
- 42c7975: Add project-level prompt defaults: a project can override the organization's choice for its own actions.
- 42c7975: Prompt notifications now deep-link into the organization's own pages, and the nomination title reads "an organization".
- 42c7975: Fix the `prompts.bind.listForStages` test expectations left behind by the project prompt tier, which were failing on master.
- 3378c7f: Publishing topics now open into a two-section Inbox with read/unread state and snooze, behind the default-off PUBLISHING_INBOX flag.
- d0db49f: Remove the retired Deferred status from the publishing topic type, completing the move to the snooze overlay
- 42c7975: QA Suite Phase 1 enabled on production workers
- 42c7975: Test cases mirrored for AI retrieval name the acceptance criteria they cover again
- 42c7975: Test-case AI context names the same acceptance criterion the coverage ring counts
- 9c5aff8: Readiness checklist: a document being regenerated no longer disappears from the checklist, and a failed re-run no longer takes it away for good.
- 9c5aff8: Readiness checklist: show when an item's work is already running, and finish without a page refresh. Also restores the callout behaviour a merge had reverted.
- 42c7975: Readiness checklist: keep an item's actions reachable while it is snoozed, reject a development start date in the past, point the chat and transcript items at something, and return the checklist to 26 rows.
- 64c156f: Rework the release BOM around attested container snapshots and a credential-free collab-worker artifact, and emit release-manifest schema 2.0.0.
- 479d829: Normalize test-fixture emails and filesystem paths to reserved RFC 2606 placeholders ahead of the public-repo flip.
- 42c7975: Clearing a prompt default keeps the binding available for one-click restore.
- 42c7975: Support 1:1 direct chats alongside group chats in Microsoft Teams Chat Monitor and integration contexts.
- 42c7975: One prompts page with Prompts and Actions tabs, and scope tabs as the library's primary filter.
- 42c7975: Close post-ship review gaps in the Temporal payload bounding: bound every MCP tool-result exit, never corrupt JSON listings, keep elision visible
- 42c7975: Bound Temporal payloads under the 4 MiB gRPC frame limit so large board pulls, story-sync listings and MCP tool results degrade gracefully instead of stalling
- 42c7975: Test fixtures now use example.com placeholder emails instead of ad-hoc short domains.
- 42c7975: Repair the generated Zod barrel so database schemas import cleanly again.

## 1.13.7

### Patch Changes

- 23162e2: Recover Teams channel-meeting transcripts from the meeting recording when Microsoft Graph declines to serve them, and stop a failed sync from reporting itself as healthy.
- 25f86df: Repair the My Overrides view so master type-checks, its prompt tests run, and formatting is clean again.
- 1761d37: Attribute retrieved code and repository context to role tags so AI answers cite the right codebase.
- 09ea06b: AI Update no longer proposes backlog changes from a meeting it never received — it says so instead.
- cdd2bdc: Stop the channel-meeting recording fallback re-ingesting occurrences that already have a transcript.
- 95c74a5: Report GitLab attachment-push failures in the sync log and the notification centre, and say what a failure actually means
- f541b61: Stop the refresh history explaining a refresh that produced topics as one that produced none, and label topic-generation jobs in German.
- d978372: Record the preference fingerprint only when the worker actually read them, and share one label-normalization rule across form, API and prompt.
- 915f27a: Publishing Suite topics can now be snoozed for a fixed period and track read state per person.
- 5caecdc: Make the project readiness checklist legible: a visible progress meter, checklist-order rows, an inline phase correction, and a refresh-free update when you switch tabs.
- 524110f: Readiness checklist: make "not ready" actually look not-ready, and make its calls-to-action land somewhere useful.
- 5caecdc: Readiness snoozes can be lifted, re-timed, and now say how long they have left; Not Applicable can be taken back
- 143f0c6: Keep AI-renumbered acceptance criteria as list items instead of escaping the marker and fencing their prose, and repair damaged specs on load
- 10afd33: Add a My Overrides view: every action where your own default prompt is in force.

## 1.13.6

### Patch Changes

- e1da628: Add repository role tagging (e.g. Legacy vs. New) for project codebases.
- db7ff7c: AI usage ledger now records failed model calls and labels four more background pipelines
- 10db681: No product change — regression tests for AI usage image-generation markers
- 330c3f0: AI usage now records background and scheduled job spend with a per-pipeline label
- 8c3f05f: Weave reader agents and the API agent now report AI usage with attribution
- 2a962e6: Pattern planner model calls now report AI usage with actor attribution
- 872de52: Failed AI calls now leave a visible trace in the usage ledger, with error text bounded and credential-shaped tokens redacted
- 6b208e4: No product change — closes the two untested paths of the background-usage attribution feature
- c24a429: Prove prompt notification delivery against a real database, permanently in CI.
- bc31c34: Reduce project-page database transfer by loading document and context summaries instead of full content bodies.
- 2db87ae: Bug-analysis log access now scopes shared log workspaces to the requesting organization and binds analysis progress reads to the authorized project.
- 5b5ca4c: The privacy banner is now dismissible without any client-side JavaScript, and its first render matches the server so a hydration mismatch cannot leave it inert.
- 62b7b59: Fix the context-source "Edit source details" dialog never opening from card menus.
- 45ca987: Fixes a stranded dropdown menu when choosing "Edit source details" from a context card.
- 1363e6e: Context source type labels and AI instructions are now on for everyone — the feature flag is gone.
- 62b7b59: Fixes the context source "Edit source details" dialog never opening when chosen from a card menu.
- e8670ef: Context sources can now carry a type label (e.g. Client Chat) and optional AI instructions that tell the model how to interpret that source.
- e2d7fcc: Release-notes review alerts and published notes can now share a chat channel.
- 48afc7e: Tab customize dialog: Reset can now be persisted when saved customizations exist, and the admin visibility switches announce the action their click performs instead of the current state.
- bb4dc34: Restore the per-deployment feature-flag gates (Atlas, Testing, Publishing Suite) as the availability ceiling over project tab resolution, and replay a tab's first-visit tour when it becomes visible to a member again.
- e2b38da: Project tabs become customizable: admins choose which tabs a project offers from Settings → General → Tab visibility, and each member can hide tabs for themselves and reorder their tab bar via a new Customize control — preferences persist per user per project across devices.
- a53a4ac: Tab customize dialog: Reset is now available immediately when saved customizations exist, without requiring a throwaway edit first.
- 00054ea: Tab Customize control becomes a quiet icon-only button so personalization is discoverable without competing with the tabs for attention.
- cb79233: Fix tab customization endpoints returning NOT_FOUND for organization projects (follow-up to the tab visibility feature): access is now resolved against the project's own organization instead of matching personal projects only.
- a0cb173: Push unlocked story attachments to GitLab; pull, and everything past it, is not built.
- b03786b: GitLab OAuth project flows pin the stored repository URL to gitlab.com
- f5c471b: Bug-analysis log access is now enabled in production, and analysis activities tag their logs with the organization id.
- 1339978: Serving the deployment log workspace for bug analysis is now operator opt-in, and the log-access ADR records the security-review tenancy model.
- e978f9c: Project admins can choose which Slack or Teams channels receive the "release notes await review" alert.
- 1e712c1: Fine-tune AI Readiness scoring to exclude dev investigation items and engineering deferrals
- 8ab654a: Release-notes review alerts now post to chat by default, and can be turned off from the admin console without a deploy.
- c7ce482: Release-notes review-alert settings tell the truth about dispatch, mark only genuinely shared channels, and refresh while a send is still delivering.
- 121eec7: Post-ship review fixes for context source labels: two more AI paths now honour source type labels and instructions, and the labeling UI is fully localized.
- 7841cfe: Post-ship review fixes: correct the log-access ADR's minter record and rename the workflow-id module to cover both id families.
- 41e312a: Fix prompt defaults set from the UI that silently never took effect, and give every binding surface a Personal option
- fc5d69d: Replace real names and production identifiers in example strings, prompts, and code comments with neutral placeholders.
- 2837944: Show why a publishing refresh did or did not notify contributors, in a new Notified column in the refresh history.
- d673ffa: Let a publishing project say which themes and post types its suggestions should favour, and have topic generation actually read them.
- 9d59d69: Give a publishing project one reprocessing run when its generation preferences change, instead of burying the content they skipped.
- b618b64: Show publishing topic generation in the Job Hub, from dispatch through to its terminal state.
- 0803117: Rename 'Done' Feature Maturation status display label to 'Requirements Complete' across all user-facing displays.
- 4817584: Sweep retirement for permanently unreadable repos; GitLab bulk-import probes; oauth-state and atlas remedy hardening
- 0c0f547: Repository access follow-through: PAT rebinding without disconnecting, repo-scoped sweep for Azure DevOps too
- 81836e2: Repository probe treats rate-limit walls as inconclusive; attach-PAT org no longer from caller input
- 9f9c9be: Recovery paths reset a No-access row's probe-failure counter, and the GitHub App link passes contrast in dark mode
- 4ce42b9: Sweep verdicts pinned to their credential snapshot; account-level probes stop flipping status on 5xx
- dae71a4: Repository status now answers whether Fabric can actually read the repo, not just whether the token is alive
- cd05de5: Retired the classic editor toggle and migrated the roadmap board's stage lanes to the three-status Feature Maturation Workflow (To Do / Discovery / Requirements Complete).
- 89ea6ab: Roadmap AI search shows a coverage note when a cold backlog was only partially warmed, and the shared story-embedding cache writes land in one database round trip instead of one per row.
- 3522358: Roadmap search results now show a relative match badge (best result = 100%), and AI search falls back to keyword results with an explicit notice when nothing matches semantically.
- a84ba80: Roadmap search now ranks results by relevance with title matches first; a new AI mode adds semantic ranking for natural-language queries.
- 403dd65: Roadmap AI search: fix active-toggle contrast, add a query-preserving "Turn off AI search" empty-state action, stop reloading the whole embedding corpus per search, and warm cold backlogs most-recently-updated first.
- 1febf01: Behind a default-off flag, block the app with an undismissable modal until a user has set at least one default role/function tag.
- a63b863: Behind the same default-off flag, ask each member to confirm their role the first time they open a project, and re-ask when an admin changes it.
- ee15cdb: Clearing a prompt default keeps the binding available for one-click restore.
- cc620b7: Act on the prompt feature's review feedback: modal overflow fix, list sort and unused filter, Org Overrides view, tier renames, and a Propose Change entry point.
- 2ffbeca: Replace the table-of-contents edge pill with a labelled spine that says what it opens.

## 1.13.5

### Patch Changes

- bb9065b: Allow the release BOM gate to discover and verify draft releases before publishing them

## 1.13.4

### Patch Changes

- 099b667: Meeting Digest: stop telling you a private meeting is already in the project (Fizzy #2170)
- de1b4f9: Show every prompt bound to an action in the catalog, and let people switch to one.
- 9e28087: Prove the batch prompt bind rolls back, and pin both prompt notification payloads against their schemas.
- 2d9631d: Let people clear their own personal prompt default from inside an organization.
- 0720af1: A prompt can now be bound to several actions at once, in one transaction.
- 89491d9: Give the refresh history's chat disclosure its own column, so the topic count can no longer be read as a channel count.
- 721c57d: Let a nomination cover several actions at once — chosen by the nominator, editable by the reviewer before approving.
- dd392da: Refuse to switch attachment sync on through the API while the feature does not exist.
- bce8441: Stop offering an attachment-sync setting that does nothing.
- a4a7729: Cover the authorization gate and the three WHERE clauses that had no tests.
- 4db8ac1: Require organization admin to fork a prompt into an organization, the same as creating one there.
- 6a142b2: Add a phase-aware project readiness checklist that shows what a project still needs before Fabric can work well on it.
- 8cfa12b: Let a project's phase be set after creation, so the readiness checklist can actually appear.
- 5152ec4: Tell the admins who can decide a nomination that one is waiting.
- f34ee87: Cover the fork scope choice with tests, so a permission gate cannot quietly turn Fork into a dead button.
- 9117fce: Listing system prompts now requires a session. It was reachable without one.
- a8ca018: Check that a nominated prompt is one its author may actually use, closing a path that could expose another tenant's prompt content.
- 471900d: Detect a codebase attached through a repository integration, and add Show All to the readiness panel.
- 70c2b7a: Let a personal default prompt override the organization's, for the person who set it.
- 23a6df2: Fix: the prompt queries module contained two NUL bytes, which made every text tool treat it as binary.
- 4e7ccc9: Let anyone propose a prompt as an organization or universal default, and give admins a review queue that shows competing proposals for the same action together.
- 115fc0f: Exercise the nomination lifecycle against a real Postgres, and apply the XOR rule to the last query that was missing it.
- 5e093bf: People subject to a universal or organization default prompt are now told when it changes.
- 9b9f4f9: Fix three ways a prompt-default approval could bind actions nobody chose.
- 9c20675: Correct the project-phase help text, which described behaviour that no longer exists.
- c7dc738: Project readiness items can now be acted on, newly completed ones are acknowledged, and link sources can be classified
- c535f62: Releases are now published only after a verified bill of materials is attached, so a partial build leaves a draft instead of a published release
- d7ef5f9: Show the readiness checklist on every project, inferring the phase when nobody has chosen one.
- ea826d9: Organization admins can see, in one list, which actions their organization has configured a prompt for.
- cd2e628: The prompt catalog now covers every agent the seeds bind, warns before an edit reaches several actions, and two authorization gaps are closed.
- 5583b29: Make "Clear Default Override" reachable for every action, and link into the catalog from where prompts are actually chosen.
- 7b4b4de: Prove tier precedence against real rows, and cover the catalog link that nothing asserted.
- 7c09b18: Cover four requirements that no test named, and make the shared-edit warning rule directly assertable.
- 1e2869d: Recognise a codebase indexed through the repository integration, not just the legacy column.
- c0621ff: Validate the notification ledger's leased-channel fence against existing rows, closing the last deferred schema obligation of the notification work.

## 1.13.3

### Patch Changes

- 0ba2106: An org or personal prompt default can now be cleared, falling back to the tier below, and a binding saved as "not default" no longer acts as one.
- 2995012: Databricks Claude prompt cache now extends across tool-calling agent loops instead of staying pinned at the first turn's prefix
- fbb9d0d: Use an attached file as the document itself, and stop offering it as generation input.
- f91412f: State the source mode inside the file upload rather than passing it from dialog state, which a debounced effect was overwriting.
- 5db9d2a: Prompts can now be browsed by the action they serve, at Feature Type › Action › Prompt.
- 47f71db: The prompt library now says which tier the default prompt comes from, and what else is available.
- 6a9b916: Document the dismissal of GHSA-8988-4f7v-96qf on the v1 `@opentelemetry/core` copy
- 949e0f1: Project document generator's finalize turn now keeps the prompt-cache prefix intact instead of discarding it on the run's most expensive call
- 6392243: Show which chat channels a publishing refresh reached, and why any were skipped or failed
- 96c3590: The Publishing Suite tab now lists past refreshes, so a run that failed or produced nothing stays visible after the next one starts
- affadab: Force the transitive `ts-deepmerge` dependency to 8.0.0 or later to clear GHSA-87mf-gv2c-c62c
- ab0c4d6: "View in Catalog" links a prompt to the actions it serves, and the catalog says which other actions each prompt is used for.
- 23324dc: Platform admins can now set the universal default prompt from the UI, and only they can.
- fe2f8bb: Register nine Temporal activities that workflows called but the worker never loaded — frame PDF export failed outright, and backlog analysis, daily briefs, story sync and orchestrator authority steps lost work.

## 1.13.2

### Patch Changes

- c1b2f83: AI Feature Assistant: an oversized attachment is refused up front, and a refused request no longer kills the chat thread
- 8a42283: Meeting Digest: the personal-meetings consent notice now accounts for importing a meeting into a project (#2170).
- 4202d84: Personal meetings: say when Microsoft cannot find a meeting, instead of failing (Fizzy #2170)
- 35c6852: Fix four things QA found on the personal-meeting import (Fizzy #2170)
- ecc77f5: Meeting Digest: stop returning another occurrence's transcript (Fizzy #2170)
- 49088fe: Authorize AI document generation against the project role model, so a read-only project member can no longer overwrite a document by regenerating it.
- 6304322: Create a project document from pasted source text, with AI drafting on by default and a type-scoped prompt to steer it.
- c1d53c4: Document agents now retry once with a larger output budget when the model returns nothing, and report the failure instead of silently leaving the document unchanged
- 931c295: Stand down every active document of a type when a new one takes over, not just one of them.
- e5f6760: Make a newly created document the active one of its type, standing the previous one down inside the same transaction.
- 45d2e17: Add QA Strategy document type to Prompt Library filter tabs, Set As Default dialog, and Prompt Binding Manager.
- 5841e8c: The Fabric Agent can now read the project's Security tab findings, enabling AI-assisted triage and ticket drafting from scan results.
- 258698b: Add an instance-admin AI Adoption dashboard showing how AI recommendations are received: taken as-is, edited, or replaced (Fizzy #2230, Phase 0).
- b868856: Show AI acceptance split by the model and prompt version that produced the output, alongside the changes that could explain a movement (Fizzy #2230, Phase 3).
- 84aa6d0: Let people rate AI chat answers, and record every human verdict on AI output in one place (Fizzy #2230, Phase 2).
- b41c2bf: Tag AI model calls with the feature that made them and the prompt version they ran with, so adoption metrics can be split per feature and per prompt (Fizzy #2230, Phase 1).
- c640bd1: Stop one malformed change costing the whole AI Update run
- add35bd: Add an Azure Monitor log source for bug analysis, and fix the context budget overshooting its cap.
- c034d0c: Stop AI Update losing a whole run over a missing sentence, and stop a search-indexing failure claiming the content is broken
- 60c894c: Cover the workflow-to-analyzer handoff for bug-analysis log context with a real Temporal execution test.
- dc91ce6: Make restore-point dumps work under row-level security, by proving the role sees every row before trusting it.
- e694985: Bug analysis can now use redacted application logs as root-cause evidence, behind a feature flag that is off everywhere pending review.
- a86cbd9: Tag chat calls where the answer is actually generated, so chat adoption is measurable at all (Fizzy #2230).
- 9354518: Tag the chat generation paths that actually run, traced from the entry point (Fizzy #2230).
- 4152117: The privacy consent banner can now always be dismissed, even in browsers whose tracking-prevention or policy settings silently block cookie writes.
- 41e900c: Count an attached file as source content, so a file can be used as the document with generation turned off.
- 43e6a9d: Switch the source mode to Use As-Is when Generate with AI is turned off, so an attached file is not routed into a run the user just switched off.
- eeb54cc: Cron routes now require the `CRON_SECRET` bearer token — the spoofable `vercel-cron` User-Agent fallback is removed
- 7409699: Surface Databricks-served Claude's cached-token usage in AI usage logging instead of showing every cached call as if nothing was cached.
- d498a7c: Databricks-served Claude now caches its prompt prefix, so repeated system prompts and conversation history bill at the cache-read rate
- 1b2d5b5: Send an explicit output-token budget on Direct chat turns so long answers stop being truncated mid-sentence
- 1b2d5b5: Stop a Direct chat turn that produced no answer from reporting success, and settle tool calls the model stream abandoned
- dc94140: Sweep documents left stuck on "generating" by a dispatch whose workflow never started, once Temporal can confirm nothing is running for them.
- 3d8ea3d: Point the two server-side document-title defaults at the shared type catalog, so the same document type stops getting two different names.
- 6ec108c: Sanitize rendered diagram markup before injection, give the prompt selector an accessible name, and parallelize two permission lookups.
- e59cca3: Offer "set as active" on any inactive document that has content, not only completed ones.
- 5169499: Drop the AI thumbs control and record spec-patch acceptance from the action itself instead (Fizzy #2230).
- 837472d: Make the OpenAPI spec-context feature flag a runtime toggle instead of an environment variable, and seed it on outside production.
- f7d103a: Stop the chat's engine pills from answering a click by doing nothing, and bound the orchestrator's MCP tool calls
- b2afe9c: Fix infrastructure deploys failing: the bug-analysis log feature declared a role assignment the deploy identity cannot create.
- f43e3f6: Run the generation started from an extracted file on the generation queue, and mark the document failed when that run does not finish.
- 4ac859b: Fix the two faults that stopped the bug-analysis log connector authenticating to Log Analytics.
- c06349d: Make every reader of a context row agree about what "not searchable" means
- 8f41206: Adopt knip for dead-code detection and remove nearly 200 verified unused dependencies across the monorepo.
- 442dcdc: Gate knip in CI so the clean dead-code and dependency baseline can't silently regress.
- 5fa0313: Demote or delete ~1,270 unused exports, types, and duplicate exports reported by knip, retiring ~12,000 lines of dead code.
- f8cdb1d: Remove 259 verified dead files reported by knip and the ten unused dependencies their deletion unlocked.
- b33ec22: Fix the bug-analysis log adapter returning nothing for real Application Insights rows.
- ae15a76: Add a repeatable script for granting the worker read access to an environment's Log Analytics workspace.
- ec8de91: Fix bug-analysis log context never reaching the model, and stop non-log MCP servers being probed as log sources.
- cb081a2: Bug-analysis log context: drop structured properties by default, require project-admin rights, and put log platforms behind a provider registry.
- 3db4c90: Make the bug-analysis log section consistent with every other prompt context source, and drop two parameters no caller sets.
- 6d603a3: Fix the weave-planners image, which stopped building, and put the other eleven langchain agents under the workspace-closure guard.
- 295743e: Answering an open question no longer loses the answer when a concurrently generated AI spec draft is accepted or rejected.
- b5f84b8: MCP project-context tools no longer report a whitespace-only extraction as readable text (Fizzy #2222).
- 0885731: Fabric MCP can now fetch a project's context sources — uploads, meeting transcripts, crawled links and notes (Fizzy #2222).
- d0630eb: Fix the defects that made Fabric AI drop the MCP servers you attached, hang on a tool call, or refuse a whole conversation
- 2fbc10a: Actually run no-parameter tools — the previous repair was a no-op against the real provider
- 1d535b4: Attach an OpenAPI/Swagger spec to a project and the assistant knows the API's endpoints, models, inputs, outputs and status codes when planning an integration against it.
- f280c7c: Run the api and temporal test suites in parallel instead of pinning each to a single worker.
- 51cc487: Pull-request review comments now say which lenses actually ran, so "nothing outstanding" can no longer mean "nothing was checked".
- b172bfc: Database promotion preflight now waits out a brief long-running transaction instead of failing the deploy on a single sample
- 9731c7e: Database promotion preflight now tells a blocked operator which `migrate resolve` form applies, instead of naming the bare command
- 8dfffdb: Let each project choose its own log source for bug analysis, instead of one setting for the whole deployment.
- a3578f3: Neutralize retrieved context before it reaches a generation prompt, so a channel message cannot forge the scaffolding the agent trusts.
- 75b751e: Bound one attempt's contributor-email walk and give it a ledger cursor, so a large roster converges instead of being killed mid-send.
- 9d1d377: Publishing Suite: the chat broadcast now heartbeats as targets finish, so a healthy fan-out is no longer killed as though it had stalled
- 60ac782: Publishing Suite: the chat broadcast's documented retry contract now matches the code — one attempt per channel, per cycle
- 7f7b0df: A mail-key outage now delays a contributor's publishing email instead of losing it, for the recipients whose only channel is email.
- f94fd85: Deferred contributor emails now actually send: the hourly sweep claims each overdue obligation, re-checks the recipient, and delivers once the mail key returns.
- 97574bb: Confine the leased delivery statuses to the email channel, so a third notification channel cannot be swept, claimed or delivered on email's terms.
- e9bb882: Publishing Suite: the hourly reconciliation sweep now clears stale contributor-notification obligations as well as stale cycles.
- 02e313b: Publishing Suite: a ready suggestion cycle is now broadcast to the project's selected Teams and Slack channels
- 05e31be: Let a project pick which Teams or Slack channels a publishing run should broadcast to, and give those broadcasts their own delivery ledger.
- e29bfc0: Stop retrying GitHub repository connections whose refresh token the provider has revoked, and prompt the project owner to reconnect instead.
- 010fbb9: Regenerate the Prisma Zod schemas for project repository integrations so `refreshTokenRejectedAt` validates correctly.
- c39a8e0: Run tools that take no parameters — `@ai-sdk/openai@3` was dropping their calls silently
- 1d9f6e7: AI document assistant can now replace every instance of a phrase in one edit instead of silently changing only some occurrences.
- d8cd21d: Temporal replay validation now fails when it replayed nothing, instead of reporting success on an empty fixture set
- a678ea8: Add GitLab and Azure DevOps repository pickers to project Settings, and fix the finish step's broken "Project settings" link
- 3f6edd2: Re-enable bug-analysis log context outside production, now that the deploy blocker is gone.
- df0701f: Drop the dead control-deck rail from the simple agent interface, offer the model picker in both modes, and default to Claude Sonnet 5
- 30cdbd0: Ship the licence and attribution notices inside every container image we publish, and enforce it on every pull request.
- 973e717: Show the reason a chat tool call failed instead of an empty red box
- ce00364: Add Focus Mode to Project Atlas and the Feature/Bug Spec Editor with keyboard shortcuts and isolated sidebar collapse
- 8c8996b: Stabilize system-prompt date prefixes so provider prompt caching (OpenAI, Anthropic, Databricks) actually hits.

## 1.13.1

### Patch Changes

- 96f99d6: AI Feature Assistant: attaching an image no longer kills the chat thread
- 390f837: Hourly OAuth-state cleanup cron no longer 401s on every scheduled tick, and a configured `CRON_SECRET` can no longer be bypassed.
- 116cb89: MCP gateway agents can now file feature requests with `fabric_create_feature`, deduped by title so a repeated request returns the existing item.

## 1.13.0

### Minor Changes

- 82e037a: Meeting Digest: you can now add one of your own meetings to a project as context (#2170).
- 4286e0f: Authenticate the Databricks AI provider with an OAuth service principal (client ID + secret) as an alternative to a personal access token

### Patch Changes

- 162fe28: Meeting Digest: three corrections to the opt-in on-device cache for personal meeting summaries (#2104).
- 5967a84: Meeting Digest: three fixes from staging QA of the personal meeting summaries work (#2104).
- ccbe5ba: Stopped the AI Assistant invoking Excalidraw for non-diagram requests and fixed diagrams erroring with "Diagram has no elements".
- 53219c9: Stop an unparseable attachment-retention entry from silently clearing the configured window instead of being refused
- bb528b0: Fix `canEditProject` so an active ProjectMember row takes precedence over the caller's org role, honoring per-project demotions.
- 9e60657: Restore the gitlab-official MCP catalog row: curate it so the registry seed cleanup stops deleting it, and re-run the enterprise seed to recreate it.
- fd66b95: Record a documented dismissal for GHSA-ggr8-5vv4-36mx (deepmerge-ts via the Prisma CLI's config loader). The advisory is patchable by a pnpm override; we decline it because that forces an unsupported major into a third-party CLI's own loader, for an availability-only flaw on a build-time path no untrusted input reaches. Unblocks the high+ dependency gate on every branch.
- 74e6a07: Surface document generation failures in the editor immediately instead of leaving the "Regenerating Document…" spinner stuck for 5 minutes.
- 1677a38: Run the Evidence Docker builder through execFile with argument arrays so caller-supplied paths and image names never reach a shell
- c593263: Cut the Fizzy import pickers' board listing from multi-MB to low-KB by opting into the upstream `fields=summary` card projection.
- 1f237f1: Retry Microsoft Graph GETs that fail with a transient 502/504 gateway error instead of dropping the sync (#2859).
- 7c1756b: Security: raise the hono and @hono/node-server override floors above their patch lines, closing HIGH GHSA-88fw-hqm2-52qc and 17 lower advisories the old floors admitted.
- 955b4f5: MCP gateway: new `fabric_create_bug` tool that files deduplicated bugs, and `fabric_list_features` now returns and filters on work-item kind.
- 09f27d0: Sanitize the `redirectTo` query param on the login, signup and onboarding forms so a crafted link cannot redirect off-origin after sign-in.
- 58048f0: Stop OpenTelemetry host-ID detection from recording a machine-id ENOENT exception on every container start
- a0d43b6: Recover 42.6 MB of headroom under Vercel's 250 MB function limit by dropping Prisma's unused database engines from the traced bundle
- a12f201: Publishing cycles stuck PENDING now raise an alert on an hourly sweep, and the email claim can no longer re-take an obligation that is no longer owed
- 25b6452: Stop paging engineers for customer-side QA pipeline sync failures, and surface a reconnect action only where reconnecting is genuinely the fix.
- 4f8d4ec: Take the full Next.js production build off the type-check critical path and persist TypeScript incremental state across CI runs
- ea0d249: Switch the roadmap Stage filter to Maturation V2 statuses (To Do, Discovery, Done) and enforce strict closed item isolation.
- e3084bf: Log the expected "Microsoft not connected" Teams state at warn instead of error, so it stops polluting prod error-level monitoring.
- 5b2efba: Attachment retention is now configurable per project and per organization, cascading to the 90-day default.
- bd2af29: Correct stale code comments claiming Better Auth's `incrementOne` is emulated/non-atomic on the Prisma adapter
- 4c071c6: Text-to-speech now decrypts the tenant's OpenAI provider key instead of sending the encrypted blob as the bearer token.
- f01491d: The 2FA gate now denies by default: any request that freshly mints a session for a 2FA user is challenged unless its path is explicitly exempted.
- 0987cac: Require a fresh second-factor verification, not just the password, to disable 2FA, rotate the TOTP secret, read it back or regenerate backup codes
- 4ef3594: Record an auth.login.success audit row when email verification auto-signs in a non-2FA user
- 291065b: Add Hidden status option to Feature Maturation V2 workspace editor status dropdown matching the Classic editor's Hidden control.

## 1.12.0

### Minor Changes

- f256350: Fix four 2FA gaps; BREAKING: Google idToken sign-in now returns UNAUTHORIZED, closing a bypass that skipped the 2FA challenge for non-web clients

### Patch Changes

- 92473ac: Add test coverage proving the account-level 2FA lockout also protects bridge-created challenges from the magic-link/OAuth sign-in path
- a186961: Add a contract test that fails when better-auth's 2FA challenge shape drifts away from the replica that gates magic-link and OAuth sign-ins
- c7ad3c6: 2FA sign-in lockout now uses better-auth's built-in policy (10 failures/15-min lock), replacing a Redis counter that could lock out legitimate users.
- f636c70: Show the "account temporarily locked" message in the 2FA settings dialog instead of the generic error when the step-up attempt cap is hit
- 2c557c0: Cap repeated failed 2FA verification attempts made from an already signed-in session, which previously had no per-account limit
- 2bba951: MCP: enforce the OAuth refresh circuit breaker, and only let evidence of a dead grant trip it
- 67066ba: Enforce user verification on passkeys so passkey sign-in legitimately satisfies 2FA instead of silently bypassing it
- 3c8cbdd: Index the publishing delivery ledger for the deferral drain page and the lease-reclaim scan, so both stay bounded as the backlog grows.
- 1d32b4a: Email-verification links no longer sign a 2FA user straight in: `/verify-email` now raises the same second-factor challenge as magic-link and OAuth.

## 1.11.5

### Patch Changes

- 3c9ccfa: Microsoft 365 now requests the Graph permissions its features actually call, so sending chat messages, sending mail, creating calendar events and listing directory users stop failing with 403
- 76e50b0: Stop an AI edit inside a code fence saving as old+new text, stop a routine save conflict reading as "Internal server error", and stop a failed AI turn poisoning the next
- f7c0d83: Stop a raw wire code reaching the user, and announce when a stalled assistant recovers
- 23ba696: Make the assistant's empty-turn diagnostic actually record why the turn ended, and pin the Attachments spacing it silently changed
- 60863d8: Tell the user when an AI run has gone quiet, and name the provider whose credit ran out
- b94ec7d: Fix a deferred save that could be cancelled or run against stale editor state
- 384939d: Document generation on reasoning-capable models gets output-budget headroom for thinking tokens, and truncated generations are now detected on gateway providers.
- b02705d: Stop document-generation retry storms from wedging agent containers: fail fast on truncated tool calls and bound streaming buffers (#2774)
- 392c6d4: Record when an agent run ends with tool calls and no text, the one path that still leaves an empty turn on screen
- f3056b2: Log the empty-turn trace at info rather than warn, since the ordinary tool-calling turn reaches it too
- 5e89bc0: Stop a deletion that spans a code-fence boundary saving the old text joined onto the new
- 188aedb: Add a read-only audit that finds feature specs whose fenced code blocks still hold text the AI accept path joined instead of replacing
- 47e337c: Harden Temporal PartyKit publishers: broadcast activities never throw, publish requests time out, and missing realtime config is logged at boot.
- 862eb89: Stop a resolved incident being re-inserted forever, expire delegated AI tokens with the run rather than during it, and stop two log paths reporting benign outcomes as errors
- 3bbe7f4: Stop the worker abandoning work on shutdown, starving its own database pool, and losing live streaming to reaped Redis connections
- d4476f1: Give the delivery ledger a deferral deadline, an attempt count, and two new states, DEFERRED and EXPIRED, to represent a deferred obligation.
- c3fb012: Rename the recoverable AI proposal dismissal state from Backlog to Rejected across the review action, archive panel, status labels, and accessible copy. Existing `BACKLOG` storage and API values remain unchanged for compatibility.
- 5cfa73d: Surface an AI run that fails after its response already succeeded, instead of leaving the assistant silent
- 7bc38e8: Stop an AI stage transition silently overwriting an edit that landed while it was running
- b4a226d: Fix 2FA login 500 by adding the twoFactor lockout columns better-auth 1.6.22 writes on every TOTP verify

## 1.11.4

### Patch Changes

- 504a8cf: Project Management settings: the auto-close and attachment-sync toggles now name the connected PM tool instead of always saying "the PM tool"
- 6c542df: The "Image unavailable" placeholder no longer leaks into saved story and document bodies, and failed-media placeholders are no longer pushed back to the PM tool
- 49b5c7f: A broken image is now actually hidden behind its "Image unavailable" message instead of rendering its native broken icon directly above it
- 7127305: Broken images in the story and document editors now show a readable "Image unavailable" placeholder instead of the browser's native broken-image icon, and failed PM-tool media imports are styled rather than rendered as bare italic text
- 3e245f1: Unavailable media in a story or document now reads as one consistent state instead of two unrelated-looking errors
- b1181ac: Pre-meeting agenda generation now uses an editable prompt from the Prompt Library. Teams can fork the "Meeting Agenda Generator" prompt and bind it at organization or personal scope to tune agenda output — item count, ordering, emphasis and section wording — without a deploy.
- 652540d: "How this agenda was built" now names the prompt that produced the agenda, not just the data that went into it. Now that the agenda prompt is editable, an agenda's shape can change with no deploy, and the expander records which prompt and version shaped each run.
- 45435e3: The agenda button on a meeting row now says what it will do. It opens the agenda panel in every state, but always read "Generate agenda" — including next to a row already marked "Agenda ready", where it looked like an offer to overwrite an agenda that had just been written. It now reads "View agenda" once one exists, "Retry agenda" when the last attempt failed, and "Generate agenda" only when there is nothing there yet.
- c458952: Close the two gaps the post-ship review found: three more AI chat surfaces never shrank images, and two more orchestrator starters had no wall-clock ceiling
- 7eed77b: Stop the AI Assistant dying on a conversation the provider refuses, and surface the provider's reason instead of an empty 400
- 086d941: Draft test cases on every route to Ready for Dev, and bill the manual draft to the project's own organization
- f955133: Recover a test-case revision the structured-output schema rejected, instead of returning an internal error
- 3d5f394: Never hand the AI provider an empty message history, and share one history-shaping helper across all six agents.
- bd5ba9e: Stop a reworded acceptance heading proposing to wipe the criteria column, and file every AI generation under the project it ran for
- e06fc69: Project context, the wizard and workspace documents now accept XML, YAML and JSON, and refuse unsupported files before upload rather than after.
- 3abbb86: Couple the drafting-failure redaction to the error the encryption module actually throws
- f27a1c4: Expanding the agent drawer to the full page now works while a reply is still streaming, instead of being blocked until it finishes
- 43f3770: Scope the default-agent availability check to the provider general chat actually runs on.
- 12a884a: Make the unified-agent-interface rollback actually roll back: gate the nav destination on the same flag as the route.
- af52d20: Stop an automatic review billing again for a commit it has already reviewed.
- dc97ee6: Suppress the destructive re-index warning when a codebase has never been indexed, and prompt the user to run the first index instead.
- 84b1bb2: Documents: tables no longer degrade into raw pipe/dash text after an AI Assist edit, and documents already damaged that way repair themselves on load
- 4777aa8: Read and comment on a pull request in GitLab and Azure DevOps, not only GitHub.
- 0bf47d3: Publish the implementation-verifier persona to Factory, and stop the document editor's status cluster squeezing out the project name on a phone
- c60cb6c: Stop shipping the LangGraph dev CLI into production agent images
- f268c32: Recover when a review's comment was deleted, and retry a comment the lenses already earned.
- 5924c81: Pull-request review findings now carry a remediation field, the QA depth tier reaches the model, a project can declare the imports its architecture requires, the dismissal rate is measured, and a review can be posted back to its pull request.
- 82a80ef: The revise-from-implementation control on a test-case row is labelled "Revise", so it stops truncating the case title.
- 23cfe10: Strip the drafting-attribution marker from a QA warning wherever the model wrote it, so the raw `Drafting revealed:` text stops showing in the analysis prose
- 5dc3ba0: Repositories connected with a personal access token (PAT) are now visible to Atlas.
- c7573ec: Move the nanoid override off the version a high-severity advisory now names.
- ddfbe5f: Log when AI-drafted acceptance criteria have to be recovered from the description
- 43eda86: Fix two Azure DevOps defects found by reading the code rather than running it: the API path named the wrong project, and the diff was the whole file twice.
- e78cef2: Stop the AI error toast from firing for background suggestions and for uploads whose caller already reports the failure.
- 374d97b: Pull requests can be reviewed automatically from GitHub's webhook, the model is shown the line numbers it must cite, and the analysis says who closes the gaps it found.
- cd0ba81: Cover the test-case auto-draft on the feature editor's own stage transition, which nothing asserted.
- cef09d1: Publish the implementation-verifier persona where Factory actually reads it, `.factory/droids/`, instead of an `agents/` folder the CLI never scans.
- 086d941: Stop the feature header's breadcrumb colliding with the PM-sync chip on a phone
- 43c17fd: Let the Orchestrator tab choose which model it reasons with, matching the picker Direct already had
- d1cc21c: Fix the pull-request comment update, which 404'd every time, and document the setup an operator and a team each need.
- 14b7bb2: Offer every connected repository in the pull-request review picker, not only GitHub, and correct the docs that still said GitHub-only
- 45435e3: A prompt whose body has no usable content is no longer accepted silently.
- fb0ecfc: Prompt version history can now be compared and restored. Selecting an earlier version shows a line diff against the current one, and restoring saves that body forward as a new version — history is never rewritten, and agents bound to the prompt pick the restored body up the same way they pick up an ordinary edit. This replaces a "Compare" button that only reported the feature as unavailable, and it means a prompt whose default text is seeded once (agent prompts are insert-only) can be walked back from the UI instead of by hand.
- 9bc7f6b: A prompt body made only of invisible characters is no longer accepted.
- 8420b42: Publishing Suite's suggestion cadence now defaults to manual generation instead of weekly.
- c052fc9: Notify project contributors in the app when a publishing suggestion cycle finds topics they contributed to.
- 4985182: Publishing suggestion cycles now email the contributors they are about, alongside the in-app notification, behind an opt-out preference.
- 764c9f3: Fix publishing suggestion cycles being reported as superseded when a persist activity retried after already committing.
- f24aa0d: Attribute test-case drafting and step revision to the project they ran for
- 2774840: Remember which comment a review was posted as, guard the webhook's foreground reads, and delete a duplicate composer the tests were pinning instead of the live one.
- 8c7cc45: Heartbeat between embedding batches so a large backlog cannot trip the analysis activity's heartbeat timeout, and align the per-input token cap with the model catalog.
- 4a44d0c: Close the four gaps left open by the QA follow-up work: the document editor's phone header, the starved project name, an uncapped AI endpoint, and features created straight at Ready for Dev
- 5d65459: Test cases now draft automatically on the default flow too, after the feature review — previously only test-first projects ever got an automatic draft.
- 1824fa6: Fail fast with a clear message when the AI provider account is out of credit, instead of retrying five times and reporting a generic failure.
- 0289329: Recover a test-case revision from four more rejected-completion shapes, and stop a failed background continuation from disappearing
- f24aa0d: Recover acceptance criteria a model folded into the feature description instead of returning them separately
- 2747c2c: Enable file, story and user mentions in Loom Orchestrator, and move the agent/model picker into the shared chat module
- 55cf2dd: Stop a truncated diff carrying a character the source never had, and stop a failed file read looking like a whole file was added.
- 2aaad47: Review a pull request for every project that connected the repository, not whichever one the database returned first.
- e21b661: Stop a deployment activating an encryption key version it holds no material for, and refuse to start a worker that has one
- cca17f4: Surface every AI failure as a clear error toast, from any provider and on any AI surface, instead of the assistant silently going quiet.
- 07535ad: Fix the architecture lens's audit record, which had started reporting a constant instead of what the run actually saw.
- 3b84bd2: Remove 27 unused files from the AI chat surfaces ahead of the unified agent interface work
- 2b22eed: The QA analysis button's tooltip now says when pressing it also starts a drafting run.
- bd99d6e: Make the project name readable in the feature header on a phone
- dd4ebeb: Let the floating agent drawer expand into the full page without losing the conversation.
- 59a0913: Add the unified agent interface rollback flag and persist the simple/advanced interface mode per user and organization.
- dd4ebeb: Persist the last-used agent in the unified agent interface, and tell the user when a saved agent is no longer available.
- dd4ebeb: Give the full-page agent chat a nav entry, so it is reachable without knowing its URL.
- 43f3770: Retire Nexus into the unified agent interface: the chat nav entry and the /nexus route now lead to one surface.
- 4578ad1: Make the AI usage interceptor report its own blind spots instead of dropping them silently
- ee54f16: Record AI usage from providers that report tokens under OpenAI-compatible field names
- 3102f1f: Record AI usage again for providers that report tokens as a v6 breakdown object instead of a plain number
- 7b1bcf5: Match a pull-request webhook to its project whichever URL form GitHub sends, instead of missing repositories stored without the `.git` suffix.
- 756532f: Batch embedding requests are now split to stay under the provider's per-request token limit, so a large backlog no longer fails duplicate detection outright.

## 1.11.3

### Patch Changes

- 93ff9e6: Add the data model, API surface and UI states for bidirectional PM attachment sync
- b988ac1: Searching the Roadmap no longer yanks you back to a previously deep-linked tab — `?tab=` is now consumed once and stripped from the URL.
- 2ebec64: Publishing Suite projects can now set how often topic suggestions are generated, how far back they look, and generate suggestions on demand.

## 1.11.2

### Patch Changes

- 3a3eb76: The historical edit-clock backfill now fills each batch in one statement instead of one per row, and runs after the catalog seeds rather than ahead of them.
- 22ee9b2: Two test fixtures no longer cast away the type error that was hiding missing required User fields.
- 7898151: Pins the three last-edit attribution behaviours that the deployed environment could not exercise.
- d5732a7: The historical edit-clock backfill no longer credits an earlier author for a change they did not make, and repairs the rows where it already did.
- 82ca759: The real-Postgres last-edit suite now runs in CI, and the concurrency guard no longer fires on writes that are not edits.
- 16094b5: Repairs four real-Postgres suites that could not run, including the coverage ranking left unverified by the semantic edit clock.
- 98c72d0: Runs four real-Postgres suites in CI that previously reported green only because they never executed.
- 8c6275d: Corrects a database test that still asserted the old Feature Maturation V2 default, and had been failing unnoticed since the default was flipped.
- 9498969: Rename the user-facing "Feature Proposals" label to "Proposal Inbox" across the proposals drawer, meeting digest copy, onboarding tour, and API docs.

## 1.11.1

### Patch Changes

- d2b8ee1: Stop the status page saying "All systems operational" above a live major announcement
- 5207677: Cap the Next build's page-data workers so the web build stops being OOM-killed.
- d1cea22: Profile the web build's memory over time to establish whether it leaks or simply peaks
- 8a88ef3: Report the web build's peak memory, so the recurring OOM can be measured instead of guessed at
- 30506b8: Feature "Updated" times and authors now track real ticket edits instead of Prisma's row-write clock, which derived summary and hash writes also moved.
- f34cb73: Generated branch edges no longer loop back on their own condition, and a template reference to an object now yields its JSON instead of `[object Object]`.
- e0a36eb: Fix Release Notes delivery to Teams and Slack channels, and surface the per-channel reason when a chat delivery fails.
- eed30b3: Block a push when the local blocked-term list is older than the shared one, before any ref reaches the remote
- b4e7e21: Run history gains a status filter and shows how each run was triggered; per-node input is recorded; an execution now names the version that actually ran; and the unauthenticated webhook health check no longer returns the workflow's name.
- b6d11f7: Pausing a workflow now takes its schedule down, condition nodes evaluate `.includes()` and node labels containing spaces, and the workflow docs are rebuilt from the live registry.
- 6594720: Release-notes reviewers now get an email, excluded items no longer read as deleted, and email failures stop being recorded as delivered
- bb789a4: Move npm publishing to trusted publishing (OIDC) and split client delivery out of the release workflow
- 1895b38: Add per-project stage visibility so hidden Feature Maturation V2 stages are omitted from the stage dropdown without affecting existing assignments.
- 3830183: Score spec readiness for bugs against a bug-specific rubric, and fix AI Readiness evaluation
- 065d4f6: Fix request spans never being persisted, so audit.tracedRequest stops serving an empty list
- 58b929a: Approving or rejecting a stale release-notes review is now a neutral no-op instead of a red "Failed to approve" banner
- 4137f2e: Turn status-announcement notifications on by default, and treat the flag as a kill switch
- 1926ee9: Show the auto-generated table of contents on feature work item pages, matching the document editor.
- 479122d: Fix uploads being refused for files the operating system does not register a MIME type for, such as `.md` on Windows
- 4747909: Workflow Editor: the canvas now fills the window instead of collapsing to a ~210px strip
- 4747909: Workflow Editor: publishing, unpublishing and rolling back a workflow now require ownership, not just membership of the organization that hosts it
- b14cc06: Cover the last of the Workflow Editor scenarios that had no test: duplication, invalid and unsaved-graph runs, list tenancy, and per-node execution logs
- eb0aaf7: Scheduled workflows now actually record their runs, and AI-generated workflows can no longer contain node types nothing can execute
- 06d7cb2: Cover the workflow tenancy gate directly, so the rule the publish lifecycle depends on is asserted rather than assumed
- 5ccbe59: Webhook-triggered workflow runs now honour the concurrency cap and run ceiling the manual path always had, and a run that fails to start is recorded as failed instead of sitting queued forever

## 1.11.0

### Minor Changes

- 1968b98: Meeting Digest: transcripts and summaries can now be expanded into a large in-place reading view.
- c02bb71: Meeting Digest: the whole meeting panel can now be expanded, not just the summary and transcript sections.
- b90e4ee: PM field mapping: derive content fields from the work item form definition, and preview the content a mapping would produce.
- 3c9ee77: PM field mapping: suggest fields from one representative ticket instead of making admins hunt through a several-hundred-row field catalog.
- 1917366: The Projects nav item now shows up to three quick-access shortcuts: your favorites first, remaining slots filled by recently opened projects.

### Patch Changes

- 673e83e: Action items captured from meetings and monitored chats can now be routed to enrich an existing ticket instead of always proposing a duplicate new one, with a diff preview and per-item override.
- a3c150e: Automatic activity capture no longer records the 75 read procedures that declare POST because they take a request body, so the audit log stops filling with reads.
- 8612835: Meeting Digest polls (agenda generation, insight extraction) now continue while the tab is hidden, so a generation that completes in the background reaches the UI instead of freezing on "Drafting…" until a reload.
- 6d63ab7: Surface terminal agent errors in chat instead of failing silently, and stop generating the malformed tool-message history that made the provider reject document generation with an empty-body 400
- 4cf4819: Burn-rate alerts now create an incident instead of being accepted and discarded, so `ErrorRateIncident` stops being permanently empty.
- 6db78ee: The customer status page no longer reports "All systems operational" when nothing is being monitored.
- e040b1b: Status announcements about a provider are now hidden from tenants who never connected that provider, which the schema already promised but nothing implemented.
- 15f4b2c: Rejected public-API key attempts are now recorded in the owning tenant's audit log when the key's secret verified, instead of being written where no read surface could reach them.
- d8f0d5e: Correct the audit_log index migration: it applies automatically, and the manual-application note it inherited was wrong.
- 30aa646: Stop the audit-retention purge from deleting rows that an audit seal already covers, which would have made the tamper-evidence chain report tampering.
- 3a38d72: Meeting Digest cleanups from the 2026-08-03 regression run: expired or stale-version personal-summary cache entries are now deleted on read instead of lingering in browser storage, and the regenerate-over-edited-agenda warning uses the app's confirmation dialog instead of a native browser confirm.
- 4762111: Corrects two false claims in the customer-status doc — one of which was wrong when it was written.
- 2cb3793: Add a customer-facing System Health dashboard, capture every successful mutation in the audit log automatically, and fix three defects in the external API-key surface.
- 2f2a7a2: The Meeting Digest page now has separate "Upcoming" and "Calendar" tabs, so you can view either without scrolling past the other.
- b117716: Add an auto-generated, collapsible table of contents panel to the document editor with click-to-jump navigation.
- 1c46919: Proposal review diffs now show the text that actually changed, instead of the first 80 characters of each side.
- 7f0fb9e: Route Fabric marketing and documentation traffic through consent-aware PostHog analytics, make TechFabric ownership explicit, send contact intent to TechFabric's contact experience, and forward confirmed Fabric newsletter opt-ins into GTM Brain.
- f7ed299: Fixes two GitLab OAuth callback tests that failed on master because the test performed real network I/O.
- 15f4b2c: Adds `/api/health/ready`, a dependency-aware health check with a per-check body, and documents why `/api/health` must stay shallow.
- 34a8820: Fixes AI Readiness evaluation failing on longer specs by replacing the hard 500-token output cap with a scaled budget.
- e1174d0: Job Hub reports a failed Slack backfill's real reason, and a channel's failure now shows on its connection row from the first failure.
- 8de6c64: Job Hub no longer reports an empty code index as success, leaves a finished job showing a queued step, or mislabels a cancelled index as a timeout.
- fbfa961: Force js-yaml >=3.15.1 / >=4.3.1 to clear the !!omap quadratic-CPU advisory (GHSA-5p4m-2wfm-xmqj).
- fd12916: AI-merged work-item bodies no longer accumulate HTML entities like `&#x27;` where an apostrophe belongs.
- 1d4067c: Update mermaid to 11.16.1, picking up its prototype-pollution hardening (GHSA-c4c3-pg64-4m4v) and diagram rendering fixes.
- eb69b4e: Patch seven high-severity nanoid advisories that were failing the dependency audit repo-wide
- ec67b72: Enable the Helm chart's NetworkPolicy by default so a bare-values deploy is segmented rather than wide open
- 48cfde2: Fix the GitLab OIDC trust policy, which trusted a branch no pipeline pushes to
- c6dfb0d: The README now states the real Apache-2.0/MIT license instead of "Proprietary and confidential", and the legal pages say which deployment they cover.
- 60153a7: Parameterize the GitLab/EKS deploy wiring so the Helm chart is no longer pinned to a single AWS account
- 07285bb: Pin the catalogued Azure DevOps MCP command to 2.8.0 so a new connection can't silently land on the consolidated tool surface
- 07285bb: Fix PM capability reads failing with a 500 on any project that has saved an inbound field mapping, which left the mapping panel with no picker at all
- ff3541d: PM field mapping: stop enumerating the whole field catalog on every settings-page load.
- a331511: Revives the request-span DB instrumentation, which had silently captured nothing since the Prisma 6 upgrade because it depended on the removed `$use` API.
- 979d402: A work item's type now decides its AI template on the server, so converting a feature to a bug no longer regenerates it with the old type's spec.
- 47edf88: Reverted the Fizzy-style notification deck: the bell popover and the inbox no longer cascade stacked notifications into a deck with collapsed strips. In stacked mode, notifications render as a flat list of cards again.
- 20f0c29: Reverted the floating notification pile: unread notifications live in the bell popover's stacked deck again, and nothing floats over the app surface. This rolls back the unreleased pile experiment, so released behavior is unchanged.
- ec195ad: Stop action-item routing from dropping a candidate whose cached embedding row disappears mid-run.
- 58f4c5a: Route action items through the shared matching stack, read whole tickets, and let a reviewer turn a rejected match into a properly-drafted new ticket.
- 7a0fde0: Action-item routing now caches ticket embeddings instead of re-embedding the whole backlog on every ingestion run.
- 014d70a: The Create-vs-Enrich routing judge now sends an output-token ceiling, so a runaway generation fails as an error rather than hanging the ingest.
- 8999af0: Scope Azure OIDC id-token permissions to the jobs that need them, and harden the OIDC bootstrap script to a least-privilege, per-environment design.
- ab7697a: Request spans are now persisted with the tenant that can read them, so traced requests actually show database activity.
- b1f1200: Make a superseded status-announcement sweep actually stop, instead of racing its own retry
- 6edb321: Fix status-announcement notifications reaching only one organization when a person is owner or admin of several
- f0a023d: Notify organization owners and admins about live high-impact platform status announcements, behind a default-off flag
- 7c84f94: Fix status-announcement notifications re-sending every 5 minutes to anyone who read one
- a944b18: Fixes two WCAG AA contrast failures on the customer status badges, and adds a test that computes the ratios from the real tokens so they cannot regress.
- e0201b6: Adds a dual-mode Specification Readiness bar with an AI Mode toggle to the Feature Maturation Summary & Questions tab.
- fc7307a: Fix sub-AA contrast on the System Health status badges, stop a datastore failure blanking the whole dashboard, and correct three documents that asserted things the code did not do.
- a2ebc72: Fix three defects in the System Health dashboard and audit activity capture found during staging verification.
- 15f4b2c: Adds integration coverage for the customer status overview assembler, including the per-signal degradation that keeps one failing datastore read from blanking the whole status page.
- 29c9229: Fix automatically-captured audit rows landing in the wrong tenant, cap unbounded global reads on the health dashboard, and add the time-ordered audit_log index the seal and retention jobs already assumed existed.
- af20079: Converting a work item's type now regenerates its body through the new type's template, and a mixed-type merge follows the surviving item's type.

## 1.10.0

### Minor Changes

- ff1e08c: Meeting Digest: opt in to remembering personal meeting summaries on your device, so re-opening a meeting is instant and costs no AI tokens.
- f09efa0: Meeting agendas now aggregate context across a recurring series and separate carried-forward "old business" from new items.
- 04f8537: Meeting action items now link to related features and bugs, with back-references on the work item.

### Patch Changes

- ff95a9a: Meeting Digest: an awaiting-transcript meeting no longer gets pushed behind "+N more" by the viewer's own personal calendar entries.
- f12cdf6: Meeting Digest now shows included meetings whose transcript has not synced yet as inert "Not synced yet" rows instead of omitting them.
- ec930b4: Meeting Digest: signing out from the sidebar now clears personal meeting summaries cached on the device.
- 9d8d395: Fix the meeting agenda under-reporting truncated context when most open action items carried forward.
- 85dc2a0: Meeting agendas now spend their whole open-action-item budget on genuinely new work.
- 53ab6d9: The architecture review lens reports circular imports, computed from the reviewed project's own index rather than asked of a model.
- 8e39484: Bump brace-expansion 5.x to 5.0.9 (GHSA-rgw5-rvv9-x895) and drop the now-moot 1.x/2.x dismissal
- 263ac08: Clear both high-severity `brace-expansion` advisories by raising the 1.x and 2.x override floors to their patched releases.
- 9041fa5: Fix dead AI-busy gates, stop-request swallowing, and the "AI is generating" pill falsely appearing during page-load handshakes.
- 74188d8: Living Documents auto-refresh gains a Daily cadence, with the jitter window scaled so daily means daily
- 778a7e8: Clear the five high+ dependency advisories published the evening of 2026-08-03
- b2c0efa: Group the Meeting Digest's upcoming meetings by day, load later days on demand, and show which meetings already have an agenda (#2106).
- 3f24da1: Refresh the Meeting Digest's agenda indicator when a generation finishes, not just when it starts (#2106).
- 0dcb036: Fix two defects found during staging QA of the Meeting Digest day headers (#2106).
- 35360d4: Make the public docs screenshots reproducible, and add two more: the Cases segment and the CI findings list.
- 01c35f8: Documents can refresh on every deploy, not only on a schedule
- 68dccea: AI-drafted test cases now arrive tagged with their test-pyramid level instead of landing unclassified
- 1f23ced: Turn on the temporal worker's sandbox wiring, so scripted QA runs can execute.
- 9b157cb: URL source ingestion now fails fast instead of retrying when a URL returns an unsupported binary content type (e.g. SVG images).
- 439b507: Greet a first-time account with a two-choice welcome dialog — take the guided tour, or explore alone — instead of the area-listing drawer.
- 988023c: Fix Daily document refresh silently behaving as weekly
- 4a22cac: Fix the Document editor masthead overflowing under the AI assistant panel at narrow widths
- 2f8af5e: Stacked notifications now render as a Fizzy-style deck: unread notifications pile behind the newest one as collapsed strips, and clicking the pile fans them out into the full card list. Read notifications sit flat below the deck, and the Unread tab stays flat (everything there is unread already). The stacked-mode empty state and load-more footer regained their container frame.
- d428e1a: Point users who have never taken the "Get started" tour at its sidebar launcher with a one-time callout and a quiet marker.
- bd7845c: Keep the "Get started" callout from opening against a launcher that has scrolled out of view.
- dac0531: Mark the "Get started" launcher with a "New" badge instead of a bare dot.
- 90685a7: Fixed an issue where highlighting text on a feature page could duplicate its acceptance criteria and corrupt the document.
- bab7063: Support uploading .html, .htm, and .xhtml files as project context and as feature assets, with their text available to Fabric AI.
- 727921e: Eliminate Node DEP0169 `url.parse()` deprecation warnings in production error logs by upgrading ioredis to 5.11.1
- efab2be: Job Hub: a slide-out panel in the app navigation showing live progress, subtasks, and failure reasons for channel-monitoring and ingestion jobs.
- 3170657: Add Apache-2.0/MIT license files, third-party notices, manifest license metadata, and the authoritative path-to-SPDX map.
- 68ca187: Fix: a meeting back-reference now opens the digest on the Actions tab, where the highlighted action item actually is.
- 4a978d0: Fix: a total AI outage during action-item matching no longer marks a meeting permanently unlinked.
- 5a136fb: Fix: a work item's "Referenced in meetings" count now reads live instead of from the 60s-stale cache.
- 6f4d9a0: Ask for confirmation before unlinking a meeting in project settings, and fix three defects found in the code that gate depends on.
- 8272d8c: A test case outside its project's QA depth tier now arrives as Proposed instead of quietly counting as coverage
- 6cef321: Replace unlicensed fonts with open families and remove colleague names from fixtures, comments and architecture records.
- 87f766b: Real organization, deployment and person names are now blocked from entering file content, commit messages, branch names, PR titles and PR bodies.
- 87f766b: Fixtures, examples and operator-facing messages now use placeholder values instead of real organization, deployment and person names.
- eda8833: Pin the relationship between the Mode B script timeout and its Temporal activity timeout so raising one alone cannot silently break runs.
- a9f7f5d: Fix staleness badge to correctly update on manual spec edits. The `handleSave` path in `StoryWorkspace` now passes the `isContextUpdate` flag, ensuring that the "Updated X ago" badge resets to "Updated just now" when a user manually types and saves changes to a story, rather than only updating on AI-driven edits.
- 22d75fb: The architecture review lens no longer reports layer rules it could not actually prove for the reviewed repository.
- 5622e1c: Add the architecture review lens: circular imports a pull request is part of, computed from Atlas's import graph with no AI involved.
- 3f3b02d: Every pull request into master now gets an automatic review comment, computed from the changed lines rather than asked of a model.
- ad5a1fc: Close the the pull-request review work requirements that were missed, and the six coverage gaps the QA lens found in its own implementation.
- 1bac156: Raise the QA lens's diff bound from 60 KB to 200 KB — measurement showed it was truncating a quarter of all pull requests, not the very large ones.
- b7ff1af: Add a per-project switch for each pull-request review lens, refusing before anything is spent.
- 4bced1b: Correct the Pull requests panel intro, which still said "No analysis yet" with both review lenses sitting directly beneath it.
- 2eaca4f: Add a Pull requests view to the Testing tab that reads a GitHub pull request through the project's own repository credential and stores the exact diff Fabric saw.
- 1836a53: Add the QA review lens: ask a read pull request what behaviour it introduces that no test case covers, with findings that cannot cite a file the change never touched.
- 0214c06: Stop the migration preflight rejecting migrations that were explicitly resolved as rolled back, which blocked every deploy.
- 5d802d8: The QA depth tier now also checks a drafted case's quality dimension, not just its pyramid level
- c58c7bb: A test case linked to a criterion Fabric cannot place no longer reads as "not mapped", and the device settings now say what they actually do.
- 1881b9c: The confidence threshold in Testing settings now does what it has always said it does: a step Fabric is unsure about reports Needs review instead of a pass or a fail.
- 3b59529: The coverage target's "record a reason" escape hatch now exists in the product, not just the API — and the QA docs gained five screenshots.
- 2b5e86a: The coverage target now blocks a feature from being marked done — and takes a recorded reason instead of being immovable.
- f9dbd73: Setting Light depth now genuinely gives you a light suite: a sceptic role whose dimension your depth excludes no longer writes cases.
- bbfe610: Settings ▸ Testing no longer shows two different names for the same depth tier.
- a285cea: QA depth tier now decides which test types get drafted, and the QA surface gains user-facing documentation
- 534e78b: The architecture review lens can now check a project's own architecture rules, not just circular imports.
- 1bfe64b: Test-first projects now draft their test cases when a feature reaches Ready for Dev, which is what the switch has always promised.
- a82f5e0: QA run screenshots now expire on a per-project retention window instead of being kept forever, and a ledger makes them findable at all.
- 8a64ffd: A feature's Testing tab now shows the run it just started, while it is running.
- bb370f1: Duplicate CI findings can now be merged into one and noise can be dismissed, three unbounded QA read paths are bounded, and a fixed Azure DevOps repository URL now clears the sync failure it used to leave behind forever.
- b1f07de: A test case can now cover more than one acceptance criterion, and the traceability matrix counts it under each.
- 0c78fe2: A person authoring a test case can now name every acceptance criterion it covers, and a criterion chosen while creating a case is no longer silently discarded.
- 159d47b: The acceptance-criterion picker and the feature coverage list now have tests that render them, and three settings rulings are written down.
- 8b96def: QA settings now save from a sticky footer instead of a button 4,000px above the controls, the scheduled result sync honours its configured interval again, and auto-filed bugs no longer carry an internal ticket number into customers' roadmaps.
- 781f425: Settings ▸ Testing gains a real **Required test types** control, and its depth tiers now read Light / Standard / Enterprise.
- cb0c4d3: Label the QA sceptic-roles control "Required test types", and record requirement traces for cards 1641, 1689 and 1688.
- 2b317ee: Test cases can now be revised against the pull request that implemented a feature, not just against its specification.
- bfd1957: "Select all N matching" can now start a run. It was the widest selection the cases list offers and the only one that dispatched nothing.
- afe6bfd: Run evidence is now shown in the run detail and can be downloaded with a usable filename, instead of being a link labelled "screenshot".
- aea291f: A blocked test run now says why it was blocked instead of "Activity task failed".
- 3a268ae: A project can require QA sign-offs before a feature may be marked Done
- 0067566: A project can now set how many QA sign-offs a feature needs before it can move to Done. The gate existed and was enforced; nothing could switch it on.
- 0a73ced: With the QA feature switched off, the scheduled sweep no longer calls a customer's CI every fifteen minutes.
- bf5861b: The QA tab now explains WHY its run list is empty, and the JUnit parser's entity limits are pinned in Fabric's own code.
- acc996b: Test-first projects now hold the line: Fabric will not start an implementation session for a feature that has no test cases.
- 564b1c8: Starting a CI run now requires choosing a pipeline, instead of arriving with one already selected.
- 7274271: The implementation-verifier persona now says the same thing to every coding tool, and CI keeps it that way.
- 548a016: QA webhook deliveries are now filtered to the watched branch, matching what the scheduled sync already does.
- 42f426e: Remove a dead workflow-id helper left behind by the deploy-refresh design change
- 81cec6b: Repair 25 comments across 24 files that an earlier automated citation removal left reading like transmission errors.
- a150534: Capture a Neon restore point before each database promotion, and correct the forward-fix runbook against a real rehearsal.
- d741553: Stop a failed restore-point capture from blocking a promotion unless --require asked it to.
- 84232dc: Support pg_dump as well as Neon for pre-migration restore points, and ship the licence with every published image.
- 957717b: Check the pg_dump client version against the server before dumping, and install a matching client in CI.
- df4885c: Serialize database migrations ahead of the application rollout, and add an expand/contract migration linter plus a release-pinned migration-runner image.
- b3a238c: Install wrangler globally and pinned in the sandbox deploy job, matching how this workflow already runs wrangler elsewhere.
- d856829: Fix the sandbox worker's deploy job, which failed on its first real run.
- 88f562d: Resolve wrangler once in the sandbox deploy job, so it stops failing on where the binary lives.
- 501ef52: Sandbox `/sessions/:id/exec` answers 400 with a readable message for an invalid request instead of 500 with the raw schema internals.
- df5b48f: The Cloudflare sandbox worker can be deployed again, and now deploys itself when it changes.
- d6d7403: Bring the Cloudflare sandbox worker into the pnpm workspace, so CI can actually install it.
- 1f10641: Replace real Azure DevOps org, project and repo names in test fixtures and a doc-comment with placeholder values
- 299c0e8: Redact connection-string passwords from CI provider bodies and ingested test failures — the previous scrub missed them entirely.
- 04efd5c: Redact credentials from CI provider error bodies before they are shown, stored, or sent to a model, and bound the size of a provider JSON response.
- b44e773: Fix the QA sign-off gate refusing edits to features that are already Done
- eec9aaa: Fix a QA sign-off being tagged with the caller's tenant instead of the project's
- c992388: Notifications can now be displayed as stacked cards — opt in under Settings → Notifications.
- 8ec1dbb: Remove 141 dead spec and ticket citations from `packages/api`, including one that was published in an API route's own description.
- cead4a8: Remove dead spec references from `packages/auth` and `packages/integrations` — second and third areas of the reference sweep.
- 717d74d: Remove 83 dead spec and ticket citations from `packages/database`, whose schema and query comments are the most-read documentation in the repo.
- 6ef7ad0: Remove dead ticket and spec references from the QA procedure layer — first area of the repo-wide sweep.
- fe72795: Remove dead spec and ticket citations from five packages, and fix a test that timed out whenever the `@repo/ai` barrel was edited.
- 7a3f307: Remove 156 dead spec and ticket citations from `packages/temporal`, including one that shipped in a Temporal schedule's operator-facing note.
- 6ba7418: Remove 188 dead spec and ticket citations from `apps/web`, the largest area of the reference sweep.
- bb965fa: Make the test-case generation settings' TDD step 3 distinguishable in the QA analysis, and record requirement traces for cards 1878 and 1834.
- 9de41b5: The temporal worker can now be given the sandbox worker's URL and auth secret, which is what scripted QA runs need to execute at all.
- 1157a49: Testing → Cases: filters are now added on demand rather than six dropdowns shown at all times, and three dropped accessible names are restored.
- c63e228: Testing: acceptance criteria in the traceability matrix no longer render their raw markdown, and the feature-tab docs cover the three analysis sections they had omitted.
- 8ac6102: Fix row density and hidden columns having no effect on the table rows.
- a7d3886: Add row density, a column chooser and a ⌘K search shortcut to the Testing tab's Cases table.
- 2e67b41: Docs: the Testing feature is now one nested section instead of four sibling pages, with a new overview, a page for a feature's Testing tab, and a work-item tutorial.
- fee1045: Docs: the Testing section's overview page is titled "Overview", so its breadcrumb no longer reads "Features › Testing › Testing".
- 803a1ca: The pull-request review documentation no longer describes two dependency rules that were withdrawn, and the testing docs cover the sign-off control and run evidence.
- bd5761e: Docs: corrects the feature-Testing-tab screenshot and its button names against the real panel.
- c68948b: Docs: adds screenshots of a feature's Testing tab and the Cases filter builder, documents the filter builder, and matches the docs' wording to the product's "QA analysis" label.
- ded3bb2: Give the feature editor's Testing tab a right rail with a coverage summary, sign-offs, recent runs and history.
- ab1e63c: Testing → Cases: adding a filter now moves focus to the control it added.
- d3e407f: Fix the vitest teardown so a green suite exits 0 instead of 1, and drop a docs screenshot that showed the pre-redesign Testing tab.
- 169d7ca: Stop the Cases table clipping its "Last run" column heading to "LAS…".
- 4807438: Make the CI findings row's actions reachable on a phone, and enlarge the section-hint tap target to 24px.
- 10a4c00: Give the Cases table's priority column enough room for its chip.
- 799ff11: Renames the remaining QA wording in the audit action reference, which sits beside the labels renamed alongside it.
- 48490c3: Renames the QA-era labels on the audit log and the webhook UI to Testing, in both locales.
- ab5a76a: Redesign the Testing surface: a dense paginated cases table with shareable URL filters, a one-line health header, and Settings ▸ Testing split into nine navigable sections.
- c68948b: Stop the Cases table overflowing its card and drawing columns over each other, and explain every column on hover.
- 0fd227b: Explain every filter, state segment and sort control on the Testing tab's toolbar.
- 0bfe6f4: Traceability: a feature's acceptance criteria are now parsed as separate criteria when the spec numbers them in prose, the coverage list opens the feature it names, and a test case's criterion is picked from the parent's real criteria instead of typed.
- 4fd8062: Meeting transcript sync now reports the exact Teams tenant-admin setting blocking transcript access instead of a generic missing-permission error.
- 7d8d542: Fix the web Docker image, which has not built since Lakebase support landed.

## 1.9.2

### Patch Changes

- 2c24c2f: Close the `uuid` 13.x advisory and raise the 11.x line, the two Dependabot findings fixable without forcing a major.

## 1.9.1

### Patch Changes

- 20ab127: A failed pipeline sync is now a banner naming the failing repo, with the provider's raw response behind a hover instead of inlined into the sentence.
- 6e9ced7: Fix the weave-planners agent Docker build failing with "Could not resolve @repo/databricks" by copying the missing packages/integrations manifest.

## 1.9.0

### Minor Changes

- ce4dd81: Meeting Digest now shows your upcoming meetings, and project admins can generate an AI agenda for one — drafted from prior meeting summaries in that series, open action items, unresolved decision-log questions, and blocked work items. The agenda is shared per meeting, editable, and everything is behind the `MEETING_AGENDA` feature flag (default off).

### Patch Changes

- 6284c15: Surface Architecture Decision Log (Decisions tab) in AI pipelines.
- d6f1df8: Keep connected code repositories authenticated: GitHub OAuth tokens now refresh on every path that reads them, so indexing, Atlas, code search, test cases and scans stop failing a day after you connect.
- 44a44cf: Resolve the fixable Dependabot advisories by bumping transitive dependencies through `pnpm.overrides`, keeping every bump inside its existing major line.
- 9677de6: Orchestrator chat streams now auto-resume across Vercel streaming windows instead of failing with "Execution timed out"
- 6284c15: Expose feature-level decision log context to agent tooling and spec update flows.
- 82e15c3: A finding's name now updates when it recurs, so findings created with a placeholder name become readable instead of keeping it forever.
- a905986: Meeting Digest transcript download is now limited to team meetings; personal meetings no longer surface the download action.
- 9677de6: Stop Vercel 300s hard kills on the fabric-ai, orchestrator, and workflow-template POST streams by exporting maxDuration above each internal deadline
- 01f0596: Close realtime SSE streams ~30s before Vercel's 300s limit and return 405 for the undeliverable MCP standalone GET stream, ending repeated timeouts.
- fe0f6ed: Report pipeline adapts to fizzy-mcp 1.1.0: paginated get_cards envelopes merge correctly and the report agent paginates using real totals.
- 14e01b9: Fix GitLab PAT connect rejecting correctly-scoped fine-grained tokens: validate against the repo (`GET /projects/:path`), not `/user`.
- 0a3621d: LOOM chat can now discover and run configured integrations like Databricks Vector Search via a shared, validated executor registry
- 5ef108f: Bring `@repo/mcp` under `turbo type-check`, which was silently skipping it, and fix the type error that skip was hiding.
- 7b49e6d: Meeting Digest: the "Connect Microsoft" prompt in the Upcoming section is now an actionable link to the Microsoft Teams (MICROSOFT_GRAPH) connect page under Settings → Integrations → Actions, instead of dead text. Previously it told users to connect but gave them nothing to click, and the underlying not-connected guidance pointed at the org "Microsoft 365" knowledge connector, which cannot grant the per-user delegated calendar access the upcoming-meetings read requires. Found during #1901 staging QA.
- 5148a35: Upgrade nanoid from 5.1.6 to 6.0.0 (4× faster ID generation; drops Node 18/20 support, repo baseline is already Node ≥22).
- a566053: Fix the "Updated X ago" badge not refreshing after an AI context refresh (Update Full Spec / Re-Evaluate Bug)
- 32a8e85: Orchestrator chat retries when the AI provider signals tool calls but streams none, and fails visibly instead of returning an empty response
- 111936a: Re-enable the orchestrator and task-agent live streams in production behind short-lived, room-scoped JWTs (issue #624).
- fb53785: PAT-connected GitHub and GitLab repositories no longer show a false "Connection error — reconnect to restore access", and are no longer skipped by the daily brief and security scans.
- ad6a1b4: Fix: CI pipeline-results sync no longer stops when a repo's code-indexing fails.
- 430ffca: Fix two credential-refresh defects a post-ship review found: connections with an unrecorded expiry were never refreshed, and a rate-limited access token was wrongly reported as needing reconnection.
- 02f67e1: Projects can now bind Databricks Vector Search indexes as read-only knowledge: agents get a search tool and "Update using context" folds matching chunks in as an external source.
- b40a4a5: A failed pipeline sync now says what the provider actually refused, instead of blaming the credential for everything.
- b903bed: A finding from a Fabric-driven test run is now named after its test case instead of showing a raw internal id, and appears without a page reload.
- 022aa4c: Re-running a failing test case now updates its existing finding instead of creating a duplicate, and a failure analysis shows the changed files it reasoned over.
- 28acfbe: Fabric can now run a test case: it drives a browser through the case's own authored steps against one of your environments, and reports what it saw.
- af8bc38: Record the owning organization on QA audit events, so run dispatches, credential changes and CI triggers appear in the organization's audit log.
- fd86b22: Announce the reason drag-to-reorder is unavailable, which #2317 claimed to do and did not.
- b9e8f6b: A test run that could not actually test anything no longer reports as passed, and a case blocked before its first step now says why.
- 3542fb9: Let cases be reordered by hand where that is coherent, and let an open question be attached to a feature as it is asked.
- 473d230: QA: Fabric can now hand you the CI configuration that makes your pipeline report test results back to it, for GitHub Actions, GitLab CI or Azure DevOps.
- cebb6ff: QA can now start a run in your existing CI pipeline — GitHub Actions, GitLab CI or Azure DevOps — without Fabric touching your CI configuration.
- 0b53e03: QA coverage completeness: export the traceability matrix for audit, and surface the automated tests CI runs but Fabric isn't tracking.
- af4799e: The traceability matrix now reports what kind of coverage each criterion has — pyramid level, spec file, proving commit, evidence count and an out-of-date flag — not just which cases exist.
- e4d7c1c: QA: the coverage target in Settings ▸ Testing now actually measures the coverage rings on the Test Cases tab, instead of only describing itself as doing so.
- d39cec0: Project documents can now be created as Test Plan, Test Report or Traceability Matrix, alongside the existing QA Strategy type.
- c261780: Re-running "Draft cases" on a feature no longer creates a second copy of everything.
- 5d16d16: A Fabric test run now executes any number of selected cases in durable batches, instead of refusing more than fifty and asking you to split the selection yourself.
- 1d73bdf: A project environment can now carry the sign-in credentials a Fabric-driven test run needs, encrypted at rest.
- 4277d9e: Let a model propose a likely cause for a tracked CI failure, as an advisory hypothesis a human reads before deciding to file anything.
- 2cb94ef: QA: adds stable failure fingerprinting, so the same broken test recognised across CI runs can be grouped as one finding rather than a fresh one every night.
- 967ef15: A failing test that recurs every night is now one tracked finding with a rising count, instead of looking new each time.
- 94a49e6: The QA tab now shows what keeps breaking, not just what happened last night — and a failure can be turned into a bug with one click.
- 19c97fd: Move test-case generation, TDD ordering and automatic bugs-for-failing-tests from Settings ▸ AI Assistant to Settings ▸ Testing, beside the rest of the QA policy.
- 2a3bf57: QA: testing unknowns raised during planning can now be recorded as tracked open questions instead of prose buried in an analysis.
- f366e5d: Scope the feature QA tab's CI run history to the runs that actually tested that feature, instead of showing every run in the project.
- 4f85301: QA pipeline results can now follow a branch of your choosing per connected repository, instead of always the repository default.
- c4d862c: QA: CI results no longer go missing — the sync cursor waits for runs that are still in flight, `@TC-7` tags match `TC-007` cases, nested acceptance criteria stop inflating the traceability matrix, and bulk "select all matching" no longer inverts when you untick a row.
- 211489a: QA gets pipeline provider marks, full run history with who triggered each run, an in-Fabric run detail, CI-run coverage, and a per-project Testing/Environments settings page.
- e4d7c1c: QA: the rigor, evidence policy and sceptic roles set in Settings ▸ Testing now shape what the AI drafts, instead of being stored and ignored.
- 1e15a28: Test cases invented by an adversarial sceptic role now arrive as Proposed and need an explicit Accept or Reject before they join the suite or count as coverage.
- 967ef15: A bug opened from a failing pipeline test now shows what CI actually reported, instead of only that something failed.
- f9b5c03: Give two shipped-but-unreachable QA capabilities a UI: the CI setup snippet, and editing a deployment target.
- 89dfeb8: Stop a second case reorder from silently eating the first, let a mis-picked feature be removed, and announce why dragging is unavailable.
- 6589568: QA: a re-run of a failing CI job now clears the test case — previously the case stayed FAILED and its auto-opened bug stayed open, because both GitHub and GitLab reuse the run id on a re-run.
- 58c12c5: Starting a Fabric test run now opens a configuration dialog — pick the environment, browser and resolution, and save the combination for next time.
- 0af2001: Explain the test-run case limit on screen instead of only disabling the button, and give the run-detail sheet an accessible name while it loads.
- 784fcbe: Say what the case limit is when a test run exceeds it, instead of "Input validation failed".
- c588d25: Show a test run's progress while it is running, instead of only when it finishes.
- 3f1fc79: QA test runs can now actually decide a step, audit rows name who caused them and reach the org log, and an environment can say where its sign-in form lives.
- da1b885: Log what the model actually returned when a test-run step cannot be decided, so the failure can be diagnosed instead of guessed at.
- 7b772bd: Pull CI pipeline results on a schedule instead of only when someone presses "Sync now".
- eb81844: QA now reports a deliberately skipped test as Skipped rather than Blocked, and the number labelled "skipped" finally counts skips.
- feb24bd: QA pipeline results: stop reporting a partly-successful sync as a failed one, and stop claiming a run reported no tests when its breakdown simply wasn't recorded.
- ac9485d: QA: with "Apply TDD approach" on, the AI feature review now reads the test cases already written for the feature and flags where the spec and the cases disagree.
- a7dd4f7: Test cases drafted from a feature now flag themselves as out of date when that feature's text changes, with AI-proposed steps a reviewer accepts or rejects.
- 22d5b51: Record the first live verification pass of the QA pipeline against real CI providers.
- a8614e2: Serialize personal GitHub/GitLab token refresh across processes, stop federated GitHub search dying silently after 8 hours, and refresh GitHub connections whose stored credentials predate expiry tracking.
- 1e581e0: Extend the code-repo token fix to GitLab and every remaining consumer: Atlas, the branch pickers and the legacy single-repo paths now refresh too, and GitLab refreshes are serialized across processes so they stop invalidating each other.
- 2284471: Repository integrations: connect GitHub and GitLab repos with a Personal Access Token, not just OAuth (extends the existing Azure DevOps PAT path).
- 942a43b: The sandbox image can now launch a browser, and CI builds it on every PR that could break it.
- 8d3fed8: Deploy pipeline now strips a UTF-8 BOM and surrounding whitespace from every secret it syncs to Key Vault, so a mis-encoded value can never silently break an environment again.
- 6a4c482: Deploy a staging collab worker (fabric-collab-staging) on Cloudflare and fail closed when the collab worker's publish/cleanup secret is unset
- ab2d988: Tool-result summarization now rides out LLM rate limits with Retry-After-aware backoff and heartbeats instead of silently truncating summaries.
- 6fde296: Fix GitHub and GitLab repo/workflow token refreshes racing each other: the four advisory-lock implementations guarding them now share one address space, so two callers refreshing the same connection can no longer both spend the same single-use refresh token.
- c28bec2: Fix the Temporal worker image build, which had failed on every master push since the agentic browser runner landed, leaving the worker undeployed.

## 1.8.0

### Minor Changes

- be09015: Add "Reset to default" to the admin Feature Flags console. A new `admin.featureFlags.reset` procedure deletes a flag's override row, returning it to its environment/registry-resolved value; the panel shows the control only when a flag's source is an explicit `override`.
- 69fba46: Add a UI-editable feature-flag console for instance admins (Admin → Feature Flags).
- 9c00b3b: User Activity now shows when a member last used Fabric, not just when they last signed in.

### Patch Changes

- b9cc7c8: Fix agent runs dying mid-generation: AI token now outlives the CopilotKit run budget, with 401-aware tool/usage logging and hardened verification.
- 2513983: Fix .xlsx attachment rejected in Loom despite the picker offering it, and let manually-created work items use spreadsheets as AI context
- 71029e4: Bump the S3 SDK from exact-pinned 3.437.0 to ^3.1094.0 with S3-compatible checksum mitigations for Cloudflare R2 and MinIO.
- edf634e: Bump brace-expansion 5.x to 5.0.8 (GHSA-mh99-v99m-4gvg OOM DoS) and time-box a dismissal for the unpatched 1.x/2.x maintenance lines
- 19fa043: Fixed a bug where the Feature Proposals badge count did not match the empty drawer by excluding `APPROVED` items from the pending count.
- 6dea71c: Files attached to a feature and marked "Context only" are now read by the AI — Clean Spec generation, feature maturation, and the AI Assistant.
- 153171a: Add Databricks Vector Search as a knowledge integration: connect a workspace, pick Unity Catalog indexes per agent, and agents gain a RAG tool.
- 26c50f6: Bump diff to 8.0.3 (parsePatch DoS/ReDoS fixes) and drop the deprecated @types/diff stub plus redundant ambient type shims.
- ff137a8: AI test-case drafting failures now say why — "Feature 3 has no acceptance criteria — add criteria, then draft again." instead of a generic error.
- 08117c6: Cut Log Analytics ingestion: drop per-heap-space `v8js.memory.heap.*` gauges (~76%) and keep each consola log call on a single line.
- 8c6ddfd: Duplicate detection now compares acceptance criteria too, and the verifier must state each item's own problem before judging.
- 79c240f: Duplicate detection now flags overlapping-scope pairs for review, weighs create-date proximity, and re-examines the backlog after logic upgrades.
- 24d869e: A duplicate scan that couldn't check anything no longer looks like a clean scan — it says so and offers "Scan again".
- ba2ae72: Fix duplicate detection re-billing an already-flagged pair every scan when the verifier later judges it distinct.
- 4310bc6: Extend PR #2198's explicit output-token budget to 17 more AI generation paths that truncated at Databricks' injected 8,192-token default (or Anthropic-direct's 4,096 fallback), and honor the MCP client's maxTokens in sampling.
- e53618f: Fix the Administration feature-flag switches appearing not to work — a toggle persisted but the row never updated until a full page reload
- 2668e64: Guard the data-analyst agent's tool loop against GraphRecursionError and wire explicit LangGraph recursion limits across sibling agents (#2123)
- 96cbb49: Fix the AI assistant panel overlapping the editor on medium-width screens (640–767px)
- a5444c6: Fix the story editor masthead overflowing under the AI assistant panel at narrow widths
- 81e6beb: Fix "Update using context" failing on large specs: send an explicit output-token budget (Databricks injects an 8k default; Anthropic SDK falls back to 4k on unrecognized models) and surface truncation as a clear error instead of "AI provider not configured".
- 2ebbe4a: Eliminate all web build warnings: keep spawn commands static to stop Turbopack's whole-monorepo NFT trace, inject the ::highlight rule at runtime, and defer extractor env warnings to actual use.
- 63d2481: Show the function-tags prompt to any tagless user, once per session, until they set tags or opt out (flag-gated; #1767 FR4).
- dad5a4d: Fix history paging dropping or repeating an entry when several events share one timestamp.
- 2f4b4ca: Fixed an issue where Atlas failed to connect to repositories by dynamically fetching the default branch instead of hardcoding it to "main".
- 443902e: Bump liquidjs ^10.26.0 -> ^10.27.1 (resolves 10.27.2) to clear GHSA-g357-x5c3-c72p (HIGH: `pop` filter bypasses `memoryLimit` accounting).
- f1a603c: Loom Orchestrator can now attach documents and Excel files as AI context, matching Direct and Nexus.
- 3f5deab: test(meeting-digest): add accessibility coverage for the meeting picker (Fizzy #1898). Test-only — an RTL test (accessible name/description, focus-into-dialog on open, Escape-to-close, keyboard checkbox selection) plus a gated Playwright test (Tab focus-trap and focus-return to the opener in a real browser, which jsdom cannot assert). No product code changes.
- 139b683: Bump Next.js to 16.2.11 (web, data-analyst agent) and 15.5.21 (autofabric) to patch four high-severity advisories
- 2466520: Security: Next.js patched to 16.2.11 (web) / 15.5.21 (autofabric) for four HIGH advisories published 2026-07-23 (SSRF in Server Actions and rewrites, App Router DoS, middleware bypass).
- b6fc332: Drop the unused `yaml` dependency from @repo/openapi-tools and cap the langsmith override at `<1.0.0` so a future major can't drift in.
- 72ce18d: Prioritizing an MCP server in the orchestrator now implicitly enables it, so a starred server's tools execute instead of being silently excluded.
- 1a9ad7e: Meetings linked to a project no longer disappear from the Meeting Digest's "All meetings" view while their transcript is still unsynced.
- 6dc5459: Opening a meeting someone else organised no longer reports a failure when Microsoft declines to look it up.
- cc914eb: Security: force postcss >=8.5.12 across the dependency tree (GHSA-6g55-p6wh-862q — arbitrary file read via attacker-controlled sourceMappingURL in CSS comments).
- ddd5a7d: The per-item AI re-prioritization affordance now hides itself wherever the server would refuse it, and joins the story form's Priority field.
- 0d4f5e5: The per-item AI re-prioritization now also appears in the roadmap row menu and the right-click menu.
- b7456d9: The board-tile menu's AI re-prioritization entries now hide on declined and completed items, matching every other surface.
- ab8f361: Roadmap Re-prioritize now weighs the project's confirmed Decisions-tab decisions as guidance, and the Priority help lists the criteria it considers.
- b5a4ec9: Test-only: cover the V1 story-editor Priority sparkle draft-sync (no runtime change).
- f0f6c5c: Priority: the per-item AI sparkle now re-assesses that item alone, and the list-wide Re-prioritize asks which set to run when filters are on and cautions before large runs.
- bbf168d: Roadmap Priority: the band editor is always open on an expanded row, and a new AI sparkle re-assesses a single item's priority on demand.
- 73d93f4: Project admins can enable a Read-only mode in project settings that blocks all Fabric writes to connected sources (PM tools, docs, chat, diagrams) while reads/sync-in continue.
- cc07cd2: Publishing Suite: recommend the best-positioned author(s) for each suggested topic
- 3c6fa29: Publishing Suite: explain why each topic is ranked where it is — a per-viewer "why ranked" line on the card.
- ed0258c: Publishing Suite: editors can confirm or override a topic's suggested post types via a checkbox dialog, falling back to the AI suggestion.
- e9f2520: Publishing Suite: credit the engineers who wrote the PRs behind a topic — PR authors with a linked GitHub account now appear among the topic's contributors.
- 1d869cb: Publishing Suite can now surface one subject as up to two angle-differentiated topic cards, grouped and labelled with a Subject line.
- 779dae0: Publishing Suite: label each suggested topic with a short angle
- b40acd2: Publishing Suite: topic cards now name project members who spoke in the cited meetings, matched from transcript speaker names.
- 5ef20d0: Publishing Suite: show a "Based on …" line on each suggested topic naming the stories, documents, and meetings (plus a PR count) behind it.
- f66d754: Test cases now have a per-case Activity timeline, and the QA tab shows the drafting-run and QA-analysis history for a feature.
- ce2ab91: Add per-project QA test-case generation settings — a switch to turn manual test-case drafting on/off (off spends no credits) and a TDD ordering preference
- b9e5c44: QA tab and case history now refresh immediately after the action that changes them, and a demoted "Acceptance Criteria" heading can no longer empty a feature's criteria.
- 61d0a5c: QA and test-case history panels now show the latest 5 entries with a "View all" dialog that pages 15 at a time instead of silently truncating.
- af9723a: QA pipeline results now pull CI test runs from GitHub Actions and GitLab CI, not just Azure DevOps (card 1834 FR2).
- 5318e01: Add the QA pipeline-results foundation (schema + linkage + feature flag) — dark, no user-facing change yet
- deee0a8: QA: graduate automated-test pipeline results out of dark launch — the "Pipeline results" section, "Sync now", and RCA→bug now ride the Test Cases feature gate.
- 17edce4: Add the QA pipeline-result ingestion engine, read API, and run-history display (card 1834) — flag-gated, dark
- bbb3005: QA: pull automated CI test results into the feature QA tab and open bugs for failing tests (cards 1834 / 1688).
- bcd21b6: Cancelling an AI test-case drafting run now guarantees no cases are appended after the cancel — and a cancel that lands before generation no longer bills at all.
- b501767: QA drafting closes its last concurrency window with an atomic per-project claim, and the QA tab's cases list pages past 100 linked cases with Load more.
- 0345816: QA drafting and analysis are now double-fire safe: overlapping test-case draft runs are rejected server-side, and re-generating an unchanged QA analysis replays the stored result instead of billing a second model call.
- 4d8aa8b: The QA tab no longer shows a phantom "AC N: \* \*" criterion from markdown divider lines, and every control on the tab now explains itself with tooltips.
- ab9daa7: QA tab hardening from post-ship review: stuck draft runs no longer block a project forever, conflict errors name the blocked features, an up-to-date analysis says so instead of silently no-opping, cross-feature risks are grounded in the project's real features, and test-case links open the feature's QA tab.
- 21de9b3: QA tab scope closure: per-criterion drafting coverage (cap now rises with the criteria count), a Cancel button on drafting runs, and acceptance criteria correctly bounded so spec sections below them no longer surface as fake criteria.
- 8c22bbe: Read-only mode: token-level write-verb detection closes the compound-name classifier gap (search_and_replace-shaped tools) without touching any real read.
- 058082f: Read-only mode hardening: close every write escape found by a five-lens post-ship review and stop blocking legitimate reads.
- ebd2ab2: Read-only mode now blocks writes to connected sources through a single global interceptor, so current and future write paths — including background jobs — are covered automatically instead of gate-by-gate.
- 2aea0a6: Fixed an issue where middle-clicking or right-clicking → "Open in new tab" on the 'Roadmap' breadcrumb incorrectly opened the project Overview page instead of the Roadmap page in a new tab.
- 5e26d4b: Fix low-contrast text in the Re-prioritize large-list caution (was unreadable in dark mode).
- be8c978: Roadmap Re-prioritize now re-ranks the whole list you confirm (up to 500 in one pass), instead of silently capping every run at 100
- fa119ce: Security: raise the shell-quote override floor to ^1.9.0 (GHSA-395f-4hp3-45gv — quadratic-complexity DoS in parse()).
- 8e2a9fe: QA tab in the feature maturation editor: AI-drafted test cases per acceptance criterion, traceability matrix, integration/E2E analysis, and under-specification warnings (card 1639).
- 6729a61: Security: force yaml >=2.8.3 across the dependency tree (GHSA-48c2-rrv3-qjmp — stack-overflow DoS via deeply nested YAML collections).

## 1.7.2

### Patch Changes

- 5cc4532: Add APP_RLS_BYPASS to the RLS deploy so fabric_app gets per-table app_bypass policies on Lakebase
- 8eb42db: Bound attachment text before it reaches the model, stop file content forging the prompt envelope, and deliver attachments inline in Nexus and Loom
- 98a7ab8: Allow attaching .excalidraw diagrams in the Create work item dialog.
- 7cc3458: Fixed an issue where edits made in the Feature item description editor — including bulleted list formatting — could be lost if the document was not saved frequently.
- fed01a6: fix(project-doc-gen): raise LangGraph recursion limit above the tool-iteration guard so long research runs finalize gracefully instead of crashing with GraphRecursionError
- b682c6e: Resolve @@group mentions with a single roster read per save instead of one read per mentioned tag (flag-gated; identical recipients on success).
- 1432dce: Add @@group mentions: address project members by function tag in documents and comments, notifying current tag-holders (flag-gated, off by default).
- 2fb2441: Fix the Biome lint violations in the Claude hook scripts that were failing the Code Quality gate on every PR.
- 4419bd8: feat(meeting-digest): add and configure meetings directly from the Meeting Digest view (Fizzy #1898)
- d1ff3b4: Scope the roadmap open-decisions query to the authorized project, closing a cross-project read of open questions within an organization.
- 4db76b7: Meeting Digest: add an "All Meetings" filter that shows your personal Microsoft calendar meetings alongside team meetings. Personal meetings are off by default, require an explicit opt-in each session, are visible only to you, and their transcripts are fetched on demand and never stored.
- 9af4ff4: Close the remaining post-ship review items: validate the input organization, replace the open-decisions row fetch with an aggregate plus a bounded LATERAL, add an AA-compliant ink token, localize the Priority row, and scan the Python lockfile.
- e383b56: Make the new --primary-ink token follow the organization's brand colour instead of a hardcoded rose.
- 059e153: Show the actual open questions on a roadmap Priority row (was a bare count) and link a work item back to the backlog proposal that created it.
- d1ff3b4: Fix repeat proposal deep links being silently dropped, bump the direct js-yaml dependency past its advisory, and clear the Priority layout's caching and overflow defects.
- a029345: Revert the app-wide dark-mode --primary change and replace the open-decisions performance claims with measured numbers.
- 62d898b: Publishing Suite: mark a topic Published with an optional URL, shown as a link on the topic list, and edit or add it afterward.
- fca67ae: Publishing Suite: personalize topic ranking by role, and enrich suggested post types with a theme and rationale.
- 43598c5: Roadmap Priority: a scored, shared worklist with per-item band history, AI re-prioritization with a review-and-revert digest, and inline change rationale.
- 684b0b8: Fix the staging outage: trace sharp 0.35's relocated libvips native libraries into every serverless function.
- a45e94c: Sync History and Change History rows are keyboard-scrollable again, and a failed sync log now shows an error instead of claiming the project never synced.
- ef1b2d8: Finish the tooltip a11y follow-ups: honest cursor affordances, real `<time>` elements, tooltips on truncated buttons, and shared destructive styling.
- 712439f: Wire a dedicated worker-database-url Key Vault secret so temporal-worker and weave-planners can connect as the fabric_worker role on Lakebase

## 1.7.1

### Patch Changes

- 8f5d7bf: Fix: AI Assistant edits no longer silently wipe a feature's Acceptance Criteria when the section heading is renamed, removed, or demoted.
- 868ad08: AI-chat attachment uploads now enforce their size cap at the storage edge and check file type on every upload path.
- 24cbb58: AI document editor now propagates a cross-cutting change to every affected section, and warns you when it couldn't fully update a section after retries.
- 0756bbd: AI spec editor now actually persists clean lower sections: the markdown-structure repair runs at the editor's save boundary, so split bold markers and split Open Questions are fixed in the saved document, not just in the agent's output.
- 12584cb: AI spec editor now repairs the two markdown breakages that used to survive into a spec's lower sections and defeat a parser: a bold marker split across a bullet boundary, and an Open Question split across two bullets.
- c8a41e2: The attach control now names every format it accepts, derived from the shared vocabulary instead of a hand-kept string.
- c18664f: Bump tar, brace-expansion, engine.io and js-yaml past the DoS advisories that were failing the high+ dependency audit.
- 055232f: Context summarization no longer discards a whole summary when one fold returns an empty model response.
- a685d89: Context summaries now cite decisions, roadmap, and code-repo sources — not only meeting transcripts — and render with readable formatting.
- 8f2badf: Destructive red now meets WCAG AA in light mode, and the 18 hand-rolled destructive confirm surfaces share one definition.
- f77b388: AI document editor now rejects and retries when a rewrite drops or collapses a whole section (e.g. Acceptance Criteria) the user didn't ask to remove.
- 16c07ea: Support uploading .excalidraw diagram files as story attachments and project context.
- fb02774: You can now attach Excel workbooks (.xlsx) in the AI Feature Assistant chat, and the assistant reads every sheet — no sheet picking needed.
- a217f24: Feature proposal descriptions and acceptance criteria now render Markdown as formatted output instead of showing raw `**`/`##`/`|` syntax.
- c766463: Fix AI usage limit emails rendering raw i18n key paths as copy and a relative, unclickable "Manage limits" link.
- 981f0f9: Add the function-tags UI (self-service defaults, per-member admin assignment, first-login prompt) plus a new Designer role (Fizzy #1767 Stages 2-3).
- 82f8434: Inject function-tag context into AI generation with role-calibrated tone, behind the opt-in FABRIC_FEATURE_FUNCTION_TAGS flag (Fizzy #1767 Stage 4).
- 48c9999: Add backend foundation for project member role/function tags (enum, per-user default, per-project overrides, copy-on-join, oRPC procedures).
- 1aa77dd: Tooltips are now legible in both themes and no longer stretch across the viewport — fixed centrally in the shared primitive instead of per call site.
- 7df23ef: Slim the internal @fabricorg/mcp-server package to hosted-server primitives; remove the broken stdio client and mark it private.
- 8f2badf: Native `title=` tooltips across the app are now real, themed, translated tooltips — and the migration fixed five accessibility defects it uncovered along the way.
- 179f13d: Fix roadmap Priority insights returning no explanations on models that emit the insights array as a JSON-encoded string.
- 18ad428: Fix drag-reorder failing on backlogs over 500 items in the roadmap Priority layout, plus permission, accessibility and contrast defects found in review.
- 6601861: Publishing Suite: topic cards now show contributor handles and AI-suggested post types, and the list ranks the topics you contributed to first.
- 6e18603: Add a Priority layout to the project roadmap: one ranked worklist per work-item kind, with blockers, open decisions and an AI explanation surfaced per row.
- 9319cc5: Security scan failures now surface a specific reason and a Try-again action in the Security tab instead of a bare "Failed" badge.
- 77c0154: Feature Maturation's Decision Log now tracks and displays the origin of every decision. Entries clearly show the author's name and exactly where the decision was captured (e.g., inline Full Spec edits, AI Feature Assistant, etc.).
- 486b77a: Fix the Review Center's "View all in Sync History" opening nothing, and stop the roadmap history tabs from resetting each other's filters.
- a22482f: Sync history moved from Project Settings into the Roadmap's change-history modal, with a "View sync log" link in Project Management settings.
- 1b0e2f9: Sync History is now readable by anyone who can read the project, matching the Change History tab it sits beside.
- 2795d62: The update banner now renders in the page flow instead of floating over the project header, where it covered the title and blocked clicks.

## 1.7.0

### Minor Changes

- 6471856: Make Fabric free to use with bring-your-own-keys: remove pricing from the landing page and disable user billing.
- 00aff25: Meeting Digest insight items now link to their source in the transcript. Each decision, action item, and open question that the AI could tie to a specific passage shows a "Jump to transcript" control; clicking it opens the meeting's Transcript tab and scrolls to and highlights the exact line. The Transcript tab also gains a Download button that saves the transcript as a Markdown file.
- 44b66cc: Meeting Digest transcripts can now be opened full-screen at a specific line. The Transcript tab gains an "Open full transcript" link that deep-links to the full-screen reader (carrying the line you last jumped to), and the reader scrolls to and highlights the line named by a `#t-<line>` URL fragment (so those links are shareable). Screen-reader users hear the landing passage announced on both surfaces.
- 7bd5be2: Add per-project custom field read-mapping for Azure DevOps — project admins can pick and order which work-item fields aggregate into a story's Fabric content.
- 146ff23: Test Cases: correct sorting and bulk actions across the whole result set, per-feature coverage, automation links, plan runs, and durable AI generation.

### Patch Changes

- 2539829: A context-summary run that folds sources but produces an empty digest now fails instead of replacing the prior summary with an empty one.
- ebdb356: Changing a context summary's source selection now forces a full rebuild, so deselecting a source actually removes it (and re-selecting one adds it) instead of inheriting the prior digest.
- ec07ca6: AI test-case drafting: salvage the retry's completion too, not just the first attempt's.
- 746bbb7: AI test-case drafting: recover a wrapped completion from the model's own text instead of losing the run to a second failed retry.
- 97338d9: Fix Administration > Users search and pagination: the search box now filters by name or email (case-insensitive) in real time, the result count reflects the filtered set, and page navigation works. (Fizzy #1709, GAP-1)
- c6330a9: Widen the Get started tour card so its navigation stays on one line
- 62b9ecc: Fix the Get started tour navigation buttons overflowing the popover card
- 0c5a9bd: Give the Get started tour a proper phone layout: full-width step bar, centred buttons
- c8f3d7c: Fix PM custom-field mapping: field enumeration failed on Azure DevOps ("every wit_get_work_item_type call failed").
- af8882a: Resolved a circular dependency during the database seed process by directly using `better-auth/crypto` instead of importing the full `@repo/auth` package. Additionally, updated the README with clear instructions for configuring local Aspire environment secrets.
- 2f182fa: Living Documents auto-refresh now reports what the last cycle actually did — a failed refresh was previously invisible.
- 44b66cc: Meeting Digest "Jump to transcript" now announces the landing passage to screen readers via a polite live region, so assistive-tech users get feedback that the transcript pane moved to the linked line (the scroll and highlight are visual-only).
- 6db4d0a: Newsletter review: highlights are now selected (checked) by default — unchecking one strikes it through and excludes it from the send
- 1338c08: Build @fabricorg/\* packages and weave agents automatically on pnpm install so dev starts cleanly after a pull
- abb460f: Add the Publishing Suite daily topic-suggestion engine (Phase 1A Plan 2) behind a default-off flag — no user-facing surface yet.
- 16b2276: Add the Publishing Suite data foundation: topic-suggestion tables with multi-tenant RLS isolation and PUBLISHING_TOPIC permissions.
- 0041f54: Publishing Suite (Phase 1A): Fabric now surfaces publishing topic suggestions from your project's code changes, calls, release notes, and feature history on a new project tab — triage them by status or add your own.
- 7db310b: Remove the user-facing Labels system from work items — Tags are now the single classification primitive. GitLab label-status sync is unchanged.
- d65e673: Clear the 7 Semgrep findings that kept the weekly security cron red (SOC 2 CC6.8/CC7.1).
- 8163ca7: Remove the wildcard CORS policy from Container Apps ingress, which was overriding the application's fail-closed CORS (SOC 2 CC6.6/CC6.7).
- 32b7e42: Add the SOC 2 CC5.3/CC7.1 Azure Policy guardrails as IaC (audit effect, off until an RBAC grant lands).
- f5913dd: Add retention for conversation and agent history, the store C1.2 names explicitly (opt-in, off until a period is agreed).
- 23cbce5: Unit-test the dependency gate, fix the MCP wrapper build, and record the scanning controls honestly.
- b2ccf11: Restore working dependency and secret scanning, and scan container images before deploy (SOC 2 CC6.8 / CC7.1).
- d7fc605: Scope the container image gate to OS packages so vendored Go binaries stop blocking deploys.

## 1.6.1

### Patch Changes

- a52a6f5: Compress a project's older accumulated context into a structured, queryable summary that the AI reads alongside recent raw context (Fizzy #1365)
- 3112e1b: Release notes can now be delivered to Microsoft Teams and Slack channels, not just email — choose Email, Chat, or Both per project.
- 2fd3107: Fix PM-state poll never auto-hiding Done/Closed cards on large projects: the hourly fetch no longer returns card title/description for every linked item, keeping its result under Temporal's 4MB gRPC limit so the auto-hide reconcile actually runs.
- 8c3786a: Fix maturation "Update Clean Spec": inline diff no longer vanishes mid-review and the "X decisions not added" banner now clears (Fizzy #1863)
- a000461: Fix "Update Clean Spec" dumping raw meeting-transcript context into the visible AI Assistant chat for bugs and features
- 5e0f5b1: Fix document AI Assistant "Update using context" / custom-prompt Confirm applying no changes and saving no new version
- 4ac5853: Add a per-project review-and-approve gate for the release-notes newsletter so admins can drop feature-flagged or unreleased items before sending.
- 8014511: Fix Databricks-served DeepSeek-R1 leaking raw `<think>` reasoning tags into output
- 648f64a: Warn when AI output contradicts a logged project decision, with an inline override that's recorded to the immutable audit log
- bd27792: chore(tooling): normalize repo-wide Biome formatting and enforce it in CI
- db3555b: Fixed a bug in the Feature Maturation V2 UI where tooltip descriptions were unreadable (black-on-black or white-on-white) by updating the TooltipContent components to use the popover surface variant.
- 6938ad8: Code fetch no longer assumes a "main" default branch — GitHub/ADO now resolve the repo's real default, fixing silent 404s on master-default repositories.
- 173d686: Code-index clone resolves the repo's real default branch instead of assuming "main", and redacts credentials from git error messages.
- 93891f4: Add an indexing-details panel to repository settings: live progress bar, indexed branch, index history, and a diff against un-indexed commits
- a4b1924: Make code indexing resume across worker redeploys instead of failing or restarting
- 4347169: Code indexing now embeds files with bounded concurrency instead of one at a time, cutting a full index build's wall-clock time several-fold.
- 0200511: Project settings now shows an honest code-search status — live on-demand vs a ready/building/failed pre-built index — instead of silently degrading.
- d6c1bc2: Code indexing now updates incrementally on a push — re-embedding only changed files and purging their stale vectors — instead of a full reindex every time.
- 491f31e: Code indexing now scales to very large monorepos: symbols are persisted per-batch (not accumulated in one call) and the workflow timeout is raised so a full index can complete.
- 9f0e279: Add activity-level tests for the code-index on-disk manifest (walk → slice reads → incremental changed-subset)
- 1e9113e: Code search now indexes every connected repository independently, with per-repo Re-index/Cancel controls and per-repo index persistence.
- 7923acc: Scale code indexing to any repo size by streaming the file manifest through disk instead of the Temporal payload
- 703ee08: Set the repository code-index details in their own inset section inside the connected-repo card
- edb6b10: Show the code-index "N commits behind" diff for GitHub, GitLab and Azure DevOps, and add per-repo manual "Update index" (incremental) + guarded "Full re-index"
- 21d27f8: Durably enable code indexing on staging via the worker deploy config (Bicep), with production off by default.
- d836921: Code-search status: report a failed or offline index check honestly instead of a false "not indexed", and stop sending the raw indexer error to the client.
- 47c6c24: Context Summary gains user controls: version history with dates + real token spend, source selection, a live progress bar, cancel, an editable admin-tunable system prompt, and manual editing with preserved references.
- 99589a4: Open the context summary in a dedicated full-page reader with breadcrumbs instead of a cramped dialog
- 88f81e6: Context Summarization now covers a project's whole history via durable map-reduce batches with a true watermark and source-level references, instead of silently truncating.
- 6569e5c: Context summaries now also fold in roadmap items (excluding hidden/rejected) and a high-level code-repo/index signal, kept intentionally high-level.
- ac3cc3b: Fix the summary roadmap gather: user_story is project-scoped (no organizationId column), so filter by projectId only.
- 9af3003: Harden the summary's roadmap + code-repo gathers so a stale worker Prisma client can never break summarization, and so roadmap items resolve reliably.
- 7f7159f: Fix roadmap reference drill-down: resolve project-scoped user_story by projectId only (it has no organizationId column).
- 5210b01: Add per-project daily-brief release-notes exclusions so admins can hide flag-gated or unreleased items (by PR or feature) from the daily brief.
- 3981beb: Fix Databricks (Unity AI Gateway) hard-fail in the api-agent by routing model creation through the shared agent-core provider factory
- 159d800: Fix Databricks (and other base-URL-required providers) misrouting to OpenRouter and enforce `requiresBaseUrl` server-side
- 194fc0f: Fix Databricks compat shim: preserve the response body on malformed JSON and handle CRLF-delimited SSE streams
- 49c49f0: Databricks BYOK now works through the CopilotKit runtime path.
- 152788c: Compile @repo/database's generated Prisma client to .d.ts, dropping type-check memory from >8GB to the default Node heap
- 09684e0: Make the backlog decision-override log truly server-authoritative — the apply path can no longer be suppressed by client input
- d28e53d: Make the AI decision pre-check always-on by removing its FABRIC_FEATURE_DECISION_PRECHECK feature flag
- 6299239: Close the last decision pre-check bypass — run the judge authoritatively at apply time when no result was relayed
- 1833fe2: Fix the AI-Update "checking decisions…" indicator sticking forever when the pre-check poll's clear was skipped
- 9f3b4e0: Harden the AI decision pre-check: audit-log integrity, admin-only override view, async backlog check, and resilient document warnings
- 4ea2a9f: Fix the AI-Update sidebar not showing the decision-conflict warning that the async pre-check surfaced a beat after the proposal
- dd54844: Polish the AI-Update decision pre-check: add a "checking…" state, stop the poll the instant it resolves, and cancel it when the panel closes
- 987f0d1: Attach .docx/.md/.txt files when creating a feature, tagged Asset (protected) or Context only.
- 0552301: Get started: add detailed page tours (and the header launcher) to the Context, Pipeline, and Reports project tabs.
- 34008f3: Get started: a CI coverage guard so a new project tab can't ship without a tour or with placeholder copy.
- 4923c1a: Get started: move the drawer's reusable chrome labels to i18n.
- bb992f0: Get started: move the per-page tour launcher into the page header as a quiet Compass, and make it reusable across every page.
- 373628b: Get started: the guided tour and new per-page tours now spotlight real in-page components (not just tabs), and each project page opens a detailed walkthrough on a user's first visit.
- a4e8ccb: Get started: a newly added page now auto-opens its tour once for existing users, not just new signups.
- 612ceb4: Get started: add a per-page "?" that opens each covered page's detailed tour, de-clutter the guided-tour card, and drop the redundant sidebar help icon.
- 6143d79: Get started: add detailed page tours + the header launcher to the remaining project tabs — completing coverage on every page.
- 952e53b: Get started: add detailed page tours + the header Compass to every top-level sidebar page.
- d3779c9: Get started: show exactly one header Compass per page (fix the duplicate on the Integrations settings page) and enforce the launcher↔page wiring in CI.
- 174ca3d: Get started: rewrite every page tour to teach what the feature actually does, not restate the screen.
- 3f613d7: Get started: harden the onboarding spotlight into a true, accessible modal and let users opt out of first-visit tours.
- 388b13e: Renamed all user-facing instances of "Clean Specification" to "Full Specification" across the Feature Maturation UI to improve clarity.
- 251fd9f: add CLI script to create and verify new users via seed:user command
- beed9ef: Living documents can be enrolled in auto-refresh: an AI keeps them current on a per-document cadence and proposes each update for review.
- b41886b: Fix MCP workspace-search embedding routing so query vectors use the same provider/model as ingest (correct serving URL for Databricks/Azure BYOK)
- bf0b28e: Meeting Digest: linked-ticket traceability with live completion checkmarks and story links, "Last scanned" timestamps, per-action-item ticket proposals (via the Feature Proposals inbox), and an inline Generate-summary button on pending agenda entries. Fizzy card 1823.
- f5123f3: Show human-readable labels for newsletter approval-gate statuses in the release-notes send history instead of raw enum values
- 955634a: Require Node.js 22 (LTS): move CI runners, engines floor, and the Evidence builder image off end-of-life Node 20
- 0360ef7: Add a Notification Settings link to the notifications dropdown and the View All Notifications page for quick access to your preferences.
- 892d682: Support self-hosting PartyKit (real-time collaboration) in Kubernetes as a Cloudflare-free alternative, plus startup validation and three-mode deployment docs.
- f49f038: Add a 60s heartbeat-timeout backstop so a stalled Fizzy MCP call fails the PM state-poll in ~60s instead of hanging it for ~15 minutes
- 35e5b95: Remove the public Release Notes page and its nav/footer links
- 7abc58e: Self-heal expired GitHub/GitLab repo tokens on the code-indexing clone instead of hard-failing the index
- 1abc81c: Revert the opt-in MCP starvation probe (#1990) — #1741's poll failure is a Temporal payload-size limit, not event-loop starvation, so the diagnostic is moot.
- f29d5d0: CI: run the RLS-policy enforcement suite under a non-superuser role in the db-integration gate
- 346aa33: Upgrade undici 7→8.7.0 and route the extended-timeout dispatcher through undici's native fetch

## 1.6.0

### Minor Changes

- f535bfe: Add Databricks (Model Serving / Mosaic AI Gateway) as a BYOK AI provider for chat, tool-calling, embeddings, and LangGraph agents.

### Patch Changes

- bd4bd1d: Add Claude Opus 4.8 to the AI model catalog as the new flagship Opus.
- 6c483bb: fix(agents): make the Databricks AI Gateway work for LangGraph agents (Claude Sonnet strict-schema compat)
- 23f6b3d: Provision a dedicated AUDIT_LOG_SIGNING_KEY (plus rotation partner) in Azure Key Vault and wire it into the Temporal worker for SOC 2 FR-6.
- 0a85c1d: Bump better-auth 1.6.11 → 1.6.13 to patch a high-severity stored-XSS advisory (GHSA-86j7-9j95-vpqj).
- 7edb5e8: fix(databricks): make security scanning (and all structured-output features) work on the Databricks AI provider
- 5b38723: Fix CI change-detection so AI model catalog edits actually seed and rebuild containers
- 7f75910: Add a contextual "Get started" drawer — a flag-aware, self-documenting overview of every area of Fabric and how to configure it.
- 5b33cb4: Security Center: incremental, branch-scoped scanning — per-branch commit checkpoints, code-scanner git-diff, and a branch coverage panel.
- 05f4d66: Meeting Digest: agenda view with day-grouped summaries, checkable action items, and one-click feature-proposal generation.
- 91b4382: Meeting Digest: stories created from meetings now store and display their source meeting; action items become first-class records.
- 3709ab2: Meeting Digest: summaries now generate automatically after transcript sync; manual Regenerate and readable failure states.
- 9ddb509: Add an interactive in-app "Get started" onboarding tour that spotlights core features for new users.
- 4931d40: Keep the Embeddings model unchanged when switching the default AI provider unless the new provider is also the "Use for Documents" provider.
- 840d96f: Review Proposals: show titles for monitored-source proposals, list all pending items, and surface monitored Teams channels/chats in the source picker.
- 84e9f47: Clarify the Security scan-branch tooltip: "Choose the branch that the Semgrep code scan and Git history secret scan will analyze."
- 27bfa74: Prevent browser credential autofill on search inputs across the app via a shared SearchInput primitive (type="search" + autoComplete="off").
- ffef649: Bump @temporalio/\* to ~1.16.3 to fix a latent workflow-isolation bug under reuseV8Context (Temporal SDK advisory #2170).
- d95e68e: fix(temporal): copy databricks package.json in the temporal worker Docker build so the worker can start
- 4ec2cd2: Test-case auto-sync no longer drops a sync when the PM-tool capability probe transiently fails — it skips only on a definitive "unsupported"
- b903f85: Test Cases: gate PM sync to tools with native test cases, move the AI drafting prompt to a customizable system prompt, and remove the dead run-results sync stack

## 1.5.1

### Patch Changes

- 20f1806: Fix langchain agent Docker builds failing to resolve `@repo/logs` after the Databricks dependency was added to `@repo/database`
- 7892831: Project Overview Document Pipeline now lists the project's actual documents with a "View More" link to the Documents tab instead of a fixed six-card preset.
- 30865d5: Add a configurable detail level (Brief / Standard / Detailed) to AI-generated release-notes newsletters.

## 1.5.0

### Minor Changes

- ff2f458: Add the project Meeting Digest surface (#1598): a browsable calendar view of a project's included Teams meetings with a per-meeting detail panel and admin include/exclude.
- 304b0cb: Add manual "Group into tickets" action that clusters open Security/Accessibility findings into thematic backlog tickets.
- fcbb011: Org-scoped User Activity dashboard (Fizzy #1709): settings page showing each member's last login and login history over 7/30/90 days, sourced from audit-log auth events. Admin/owner only, behind FABRIC_FEATURE_USER_ACTIVITY_DASHBOARD.

### Patch Changes

- 699a5bb: Remove the orphaned StoryEditorSheet 4-tab editor and surface feature provenance via an info popover in the live editor
- f87a9f5: Add a story-level comments entry point to the live feature editor; reject cross-story/cross-task comment-reply parentId.
- 64219bc: Meeting Digest follow-up fixes (#1598), from staging verification:
- d348d8c: Meeting Digest: meetings now self-populate their summary and Decisions/Actions/Questions tabs.
- 8cfb64f: Meeting Digest: month navigation, expandable day overflow, transcript tab in the meeting detail, and a note for included meetings with no synced transcripts.
- 0577d8a: Meeting sync: optional 90/180-day backfill window on "Sync now", and the Meeting Digest config panel now shows each series' last meeting date.
- e65ecd1: User Activity: the member drawer's daily-login chart now actually renders, plus a11y and audit-catalog polish.
- 570d6e0: Feature editor: attachment count badge, comments active-state, and dedicated-attachments uploader now accepts Markdown and common video files.
- b404dc1: Show a comment count badge on the feature editor comments icon, matching the attachment badge, so discussion is visible at a glance.
- e034c3a: Maturation V2 editor: merge "Update using context" into "Update Clean Spec" and show a summary-loading indicator from first render
- 8523f05: Feature Maturation V2: restore the yellow staleness tint at the 1–2 week band on the "Updated X ago" label
- 2076478: Make the Maturation V2 AI Summary first-load state a visible "generating" indicator instead of a bare micro-spinner
- e87affb: Enable Feature Maturation V2 for all organizations and personal workspaces
- 15c8df9: Route every work-item creation path (manual, Slack/Teams, AI Update, transcript) to the Clean Spec prompts instead of the legacy draft templates
- 7ce513a: Allow the Nexus composer to send without an explicit agent selection
- e21e047: Add Playwright dependencies to mcp-stdio-wrapper Dockerfile
- 132965a: Fix the AI Assistant reporting "no repository attached" when a repository is connected but its credentials expired or its code is still indexing.
- d9b0ccb: feat(ai-usage): reconcile AI usage rows to the gateway's actual billed cost instead of a computed estimate
- 1e80ab5: feat(ai-usage): LangGraph agent usage carries the gateway generationId + full token breakdown, so it reconciles to actual cost
- 1a7e053: Make Atlas analysis resilient to worker disruptions: detect a dead worker in ~2 minutes instead of 30, and resume the AI work instead of restarting it.
- 5d33c19: fix(atlas): yield to the event loop during graph assembly so large-repo analyses don't heartbeat-timeout
- 7fc65bd: fix(atlas): repo-agnostic shallow clone — stop partial-clone/promisor failures breaking analysis on large repos
- c529e6a: fix(atlas): auto-rebuild the Temporal worker on @repo/atlas changes and retry the repo-credentials read on a transient DB error
- 6261f3c: Presence bar shows "Viewing Atlas" for stale clients still broadcasting the legacy "understanding" tab id
- 878e5fa: Atlas: restore the blobless (`--filter=blob:none`) analysis clone for a minimal disk footprint, with a back-fill retry for robustness.
- 6191d74: Make the Atlas structure (clone+parse) phase resumable, so a worker disrupted mid-parse continues instead of re-parsing the whole repo.
- b70c0d4: AI Assistant: show an informational notice when an attached file is empty (0 bytes) instead of silently ingesting no context.
- b8344b7: Graduate dedicated attachments to always-on: remove the six #1702 feature-flag gates.
- 242781f: Add an opt-in sweep that reclaims orphaned attachment objects under story-attachments/, closing the F2 crash-window residual (#1702).
- 400770a: removeAttachment re-checks storage-key ownership before its best-effort delete, narrowing the #1702 key-reuse ABA window (F1).
- 66b105e: Add opt-in attachment retention: removeAttachment soft-deletes instead of hard-deleting; a daily job purges expired rows + R2 objects (#1702 Part 5).
- 78556ff: Add a daily, opt-in Temporal sweep that reclaims abandoned attachment temp-uploads once they are provably past promotion, closing the last storage-hygiene gate before the dedicated-attachments feature can be enabled.
- ea7ceed: Surface dedicated story attachments in the live feature editor via a flag-gated Attachments panel
- e5571d3: Add opt-in cryptographic sealing that makes the audit log tamper-evident (SOC 2 CC7.1/CC7.2): an hourly job chains and HMAC-signs a seal over each window of rows, verifiable on demand.
- 10c7390: Label the Backlog view's back link "Back to Backlog" (was "Back to inbox")
- c7e19ea: Make the Backlog a dedicated list, separate from the review inbox
- 66eeb92: Refine the AI-suggested Backlog flow: funnel through Backlog before Reject, and a quieter roadmap entry point
- bcbe0d0: Harden background Temporal workflows against transient Postgres connection/auth blips so they retry instead of hard-failing
- 364eae2: Reclaim attachment objects on every bulk story/project deletion path, closing R2 storage leaks that the single-story delete already avoided.
- e833760: Add a Cancel button to in-progress report generation jobs in the Report Center
- aeec508: Add user-to-user threaded replies to feature and task comments (single-level nesting).
- 6d73212: Close the promote-after-delete orphan race in create-attachment so a concurrent parent-delete can no longer leave an orphaned attachment object.
- e33b59f: Databricks Phase 1: run Fabric's Postgres on Lakebase — new @repo/databricks auth package, OAuth connection rotation, and a WORKER_RLS_MODE fallback.
- 8800fa9: Document the "Group findings into tickets" capability in the Security & Accessibility feature guide.
- b8be13f: Revoke GitHub/Slack OAuth tokens on disconnect and tenant-isolate agent workspace-file storage paths (F-099)
- 7a413c5: Add an in-editor Notify action to tag project members and deep-link them to a feature
- 8bb2e0d: Security findings: fix broken feature/ticket links and stop hiding half the findings
- 6a2deac: Fix scheduled reports failing with "Complete result exceeds size limit" by bounding the agent loop's gathered data to Temporal's payload limit.
- 9f75d56: Fix the Roadmap "Backlog" proposal-count pill 404ing on org-shared projects
- 7a71a7d: Fix two latent master build breaks: lazy-init the AI-credit Decimal (`Prisma is not defined`) and commit the patched generated Zod schema
- 6d7bbd8: Fix the Review-inbox "Failed" proposal-count 404ing on org-shared projects
- 7d7c709: Fix repo OAuth connections expiring every few hours: project-repo token refresh ran $queryRaw on a void-returning advisory lock and threw on every attempt
- 21fd96a: Fix a generated-Zod build break that failed `@repo/weave-core`'s build and blocked master/staging deploys (apply the `fix-zod-imports` post-generate step).
- d9585a0: Fix production deploy break: regenerate zod schemas without stale `Prisma.Decimal` refs
- 5f5ade5: Fix broken GitHub repository reconnect (regression from #1822): send a relative returnUrl to the OAuth start
- a079e57: Stop the gitleaks allowlist from hiding a real inter-service HMAC secret; scope markdown allowlisting to docs directories only
- 2bc16f1: feat(ai-usage): record every AI call automatically via a global model interceptor + price prompt-cache tokens correctly
- 15e19b3: Fix: an empty "Group into tickets" review (e.g. after declining or re-adding every proposal) now shows "Finish review" so the run can be completed, instead of leaving it stuck awaiting review and blocking new runs.
- 35fbe9f: Add a manual "Reattach" action to the security finding-grouping results so a theme can be pointed at an existing ticket of your choice.
- c60d4d5: Security "Group into tickets": a proposed ticket is never headlined "Untitled" — the title generator's literal "Untitled" (and empty/blank-rule themes) now fall back to a rule-based title.
- 02c2af2: fix(infra): stop the SOC2 diagnostic-settings conflict that was failing every Azure deploy
- 3df3f62: AI Assistant now treats dedicated (locked) attachments as read-only: it must never modify, delete, invent, or claim to have analysed them.
- 6f9dc22: Feature Maturation V2: AI now proposes recommended answers (with multiple-choice options) for newly surfaced open questions, with a per-feature toggle to turn it off.
- d9a058d: Feature Maturation V2: the AI answer-recommendations dogfood flag now also hides already-generated options at the display layer, so turning it off fully reverts to baseline behavior.
- 488d8fb: Feature Maturation V2 AI answer recommendations: each suggested answer now shows a justification, options are org-editable per ticket type, and the feature is gated by a dogfood flag.
- cbcdaba: Redact MCP tool-call argument values from worker logs — log argument keys only, never card title/description/body.
- 3a89398: Roadmap sort order now persists per user and per project, restored automatically across navigation and sessions.
- d2814f0: Fix PM state poll dying inside a hung Fizzy fetch so Done features auto-hide again (Fizzy 1741)
- 98c503a: fix: update Azure DevOps URL regex patterns to support optional project segments and clean up formatting
- 03343c0: perf(report-agent): cache the report loop's growing conversation prefix so each iteration isn't re-billed for the whole transcript
- b3b0ad1: Reviewers can now defer an AI-suggested proposal to a new "Backlog" status instead of only approving or rejecting it
- 5bcfc6b: Move the scheduled production-release tick to 07:00 UTC (from 09:00); the day is still gated by the `PROD_RELEASE_DAYS` variable.
- 6dee3a9: Scheduled prod-release now merges the Version PR with `--admin`, bypassing its "awaiting approval" required checks — the same "merge without waiting for requirements" a maintainer does by hand, safe because the version-bump-only PR's code already passed CI on master. Conflicted PRs are still left for a human.
- 1375487: Scheduled prod-release can now merge the Version PR with a self-service `RELEASE_MERGE_TOKEN` PAT (preferred when set), falling back to the Release GitHub App — so releases aren't blocked on an org owner granting the App `pull_requests` permission.
- 353fd26: Production deploys now post a single completion notification (success or failure, with the released version) straight to a chat webhook from CI — no in-app service in the loop.
- 6ddcf77: Production deploy notifications now also fire for manual `workflow_dispatch` prod deploys, not just tagged releases — so both auto and manual prod deploys post to chat.
- 52f418b: Harden the production deploy-notify and scheduled-release workflows: bound both jobs with `timeout-minutes` so a stuck API call can never hang, and retry the chat-webhook POST on transient network failures.
- 8d81cde: Scheduled reports no longer fail intermittently when the agentic data-gathering model returns an empty turn
- 9312acb: Eliminate empty-turn truncation in report generation: cap model output tokens, detect provider stream truncation via finishReason, and retry transient drops with backoff.
- 1581d05: Fix the "Review findings" proposals dialog flashing a stale prior review when re-run on a fresh page load.
- ca7ff42: fix: update Playwright MCP command arguments and remove redundant seed configuration
- 7f3a9f0: Fix a foot-gun in the git-history secret-remediation runbook: replace `git push --force --mirror` with delete-only tag handling
- 0dcd1e8: Security scan: scan chunks with adaptive gateway-aware concurrency (AIMD) instead of strictly one-at-a-time
- 4d53d08: Add per-branch security scanning: pick which git branch the repo scanners (Semgrep SAST + git-history secrets) clone, recorded per scan, with a branch-aware results view.
- 15706e8: Security & accessibility scans that fail wholesale now explain why (AI model rate-limited / timed out / temporarily unavailable) and that it's usually temporary, instead of a bare "Every scanner failed to complete".
- 937b94a: Stabilize security/accessibility finding identity so a full rescan carries findings forward and groups into the same tickets instead of creating duplicates, and give large scans enough time to finish.
- 548f3c7: Security scan: sharply cut false positives, and actually deploy the FP contract
- a8ed94c: Security scan: feed real code evidence to the false-positive judge, auto-triage findings, and default-hide low-signal audit noise
- d286d9c: Security scan hardening: close review-found gaps in the adaptive-concurrency + cancel changes
- 2a172b8: Cache the AI security/accessibility scanner's fixed prompt as a provider-agnostic system prefix so it is no longer re-billed on every content chunk.
- d348d22: Security scan: suppress self-referential "echo" false positives — flag Fabric-held tickets/docs/test-cases only for real sensitive data or a concrete introduced flaw
- f62ffc5: Security scan: raise the AI scan activity timeout to 60 min (single attempt) and add a Cancel button to stop a running scan
- c76bd99: Suppress confirmed secret-scan false positives via a committed `.gitleaks.toml` allowlist and add an optional local pre-commit secret scan
- d281151: Fix the "Group into tickets" results dialog flashing a stale prior run on re-run, and cap the finding-grouping LLM prompt for very large themes.
- 8390637: Security "Group into tickets" now previews each ticket before creating it — per-ticket PM-sync choice, persistent decline + one-click re-add, and large themes split by severity.
- 83dcd1b: Harden the self-hosted deployment for SOC 2: assert runAsNonRoot on the agent pods, and make RDS Multi-AZ, backup retention, and apply-immediately configurable for production.
- e36e879: Add a per-account 2FA verify lockout so TOTP can't be brute-forced across many IPs
- bf4b084: Make the audit log tamper-evident: append-only WORM trigger on audit_log and preserve the audit trail when an organization is deleted
- 53a5ac3: Audit ALL login methods, not just password, and fix the verify-totp MFA-enrollment miscoding (SOC 2 CC7.2 — H6).
- d2e268f: Fix audit-log retention purge to set the WORM bypass GUC so scheduled deletes are not blocked by the new append-only trigger
- 2ed0e20: Harden authentication: fail-closed BETTER_AUTH_SECRET boot guard and a server-side forced-password-rotation gate that cannot be bypassed by cookie tampering
- 5fb854a: Fail closed on CORS: the shared agent server and sandbox worker no longer default to a wildcard Access-Control-Allow-Origin in production
- 4b7f058: Add a Report-Only Content-Security-Policy and a violation-report endpoint to measure a future enforced CSP without breaking the app
- 3c9c741: Purge project-document blobs on permanent delete and escalate an orphaned-Qdrant failure to error
- c5e7f06: Remediate the dependency-vulnerability backlog (SOC 2 CC7.1): fix the 1 critical + 22 of 24 high advisories and restore an always-on high+ audit gate.
- 210d6e4: Encrypt DataConnection credentials, webhook signing secrets, and Account OAuth tokens at rest (SOC 2 encryption-audit remediation).
- 3a5fbae: Encrypt the GitHub OAuth auto-heal DataConnection token write, completing at-rest encryption across every write path (SOC 2 CC6.1).
- 932679e: Complete the self-hosted SOC 2 requirements FR-2 (production Terraform profile) and FR-7 (all Fabric containers run non-root).
- c7ce2df: Encrypt Account.idToken at rest via Better Auth databaseHooks (SOC 2 register E10) and reconcile the compliance docs with the shipped key rotation.
- c984671: Stop leaking partial credentials and PM-card content to logs (SOC 2 CC6.1), surfaced by the integration data-flow review.
- cbe91f1: Activate encryption key version 2 for dev/staging (SOC 2 CC6.1 key-rotation flip); prod stays inactive until the ordered later release.
- 3483e72: Wire versioned encryption keys (ENCRYPTION_KEYS) through Bicep, the deploy workflow, and the Vercel env sync; add the key-rotation runbook (SOC 2 CC6.1).
- 4247ff5: Add opt-in versioned key rotation to the encryption primitive (SOC 2 CC6.1 — bounded key blast radius).
- 42bb605: Fix the SOC 2 Key Vault unauthorized-access alert to count real 403 denials, not the benign 401 Azure AD auth challenge that was paging SEV-1 every ~15 min
- ba9b347: Harden audit-log secret redaction and make internal service-token checks constant-time (SOC 2 CC6.1/CC7.2)
- 9a9d6f8: Record MCP credential-config deletion in the audit ledger
- 8a55945: Add opt-in organization-wide two-factor authentication (MFA) enforcement
- 8af1a51: Redact sensitive keys from request-span attributes before persisting so secrets never land in request_span rows
- 8af1a51: Add a default-on daily retention job that purges request_span rows older than 7 days
- 9fe9139: Sanitize 500 error bodies, fail /metrics closed in production, and fix reflected XSS + open-redirect on the GitHub OAuth callback
- 8f2e2a4: Close a GitHub OAuth callback open-redirect, revoke GitHub tokens on disconnect, and make the org.deleted audit row durable (SOC 2)
- 1e760bb: Fix a silent RLS allowlist bug and add an enforced RLS-coverage guard (SOC 2 CC6.1).
- 4d611dc: Add baseline HTTP security headers (HSTS, nosniff, Referrer-Policy, Permissions-Policy) and a production database-TLS enforcement warning
- 4f8c30d: Harden SSRF and egress: block internal/private targets on tenant MCP + workflow-HTTP requests, and fail closed on plaintext Redis in production
- d4f4e45: Fail-closed TLS for the Temporal connection in production (SOC 2 CC6.7).
- 5d3b784: Close a systemic cross-tenant authorization gap (SOC 2 CC6.1/CC6.3): verify org membership against the resolved input org, not just the session org, across the oRPC API.
- 0c0df94: Fail-closed TLS to Postgres: production refuses to start if DATABASE_URL does not require TLS (SOC 2 CC6.7).
- 166f33d: Fail-closed webhook authentication + clickjacking protection for the authenticated app (SOC 2 CC6.1 / CC6.6).
- 6108fdd: Fail closed on webhook secrets: require KANBAN_WEBHOOK_SECRET in production and make new agent webhook triggers signature-required by default
- 672c183: Fix proposal-attached screenshots not rendering in Fabric stories, and place them above the "View in Fabric" link
- da0ffac: Subscribe to document and feature change notifications: opt in to a document or feature and get a notification whenever it changes
- e21e047: Add the official Playwright MCP server to the registry seeders.
- 8f9ace2: filter document metrics by active status and update total count calculation in the overview tab
- aa09fa4: Test Cases: the per-case "Auto-sync" toggle now actually pushes edits to the PM tool (it was a no-op).
- 406abe4: Test Cases: show a "Test Cases" breadcrumb crumb (matching the feature editor), and stop a concurrent double-push from creating duplicate PM work items.
- febdfad: Test Cases: harden the delete/reset confirm dialogs and extract shared sync-gate + plan-form components (internal quality, no behavior change).
- f2c1acf: Test Cases: the work-item "tested by" indicator is now a compact icon + count with a hover tooltip, and clicking it drills into the covering test cases.
- c1c5f95: Test Cases: the global Fabric Agent is now aware of the test cases on screen when the Test Cases tab is active.
- 5d1d5cf: Fix test-case push to Fizzy failing with "Account slug is required" — thread the connected tool's account_slug into the flat create/update args.
- 5d6de08: Test Cases: add plan edit/delete + Active/Inactive, gate the case PM-sync controls on tool capability, and fix a dialog a11y warning.
- ec081ea: Fix PM test-case import failing with "Project not found" on organization projects, and the import dialog overflowing on long ticket titles.
- dd05d72: Fix PM test-case import for tools that key work items by an internal id (e.g. Fizzy): import by the display id so the card is actually found.
- 8b5ad4b: Fix a 500 when re-importing a PM work item whose Fabric test case was previously deleted: resurrect the soft-deleted case in place instead of colliding on the unique index.
- dc163db: Test Cases: browse the connected PM tool and import its work items as test cases from the Test Cases tab.
- de59937: Fix: test-case push now stamps a drift baseline, so a PM-side edit is detected as a CONFLICT instead of being silently overwritten.
- a71a087: Test-case PM sync now works with any create/update-capable PM tool, not just Azure DevOps; unsupported tools get a disabled sync control.
- 3885d25: Add Test Cases (authoring, manual run results with provenance history, and capability-tiered PM sync) behind the FABRIC_FEATURE_TEST_CASES flag — default off.
- 3d8f9b5: Redact PM work-item titles and other business content from temporal-worker logs — log metadata (lengths, IDs, booleans) only.
- 33fae71: Repair the generated Prisma Zod schema so the web type-check/build passes again (BigInt defaults + Decimal validators).

## 1.4.3

### Patch Changes

- f97d732: Rename the "Code Understanding" feature to Atlas everywhere — the project presence bar now reads "Viewing Atlas" instead of the raw tab id.
- 9fe466a: Fix the "open existing ticket" affordance not appearing on Feature Proposal "Update" rows that reference an existing ticket.
- a3d2105: Correct the temporal-worker resource bump to 1.75 vCPU / 3.5 GiB (heap cap 2560). The previous 2 vCPU / 4 GiB failed Container Apps preflight: on the Consumption profile the TOTAL across all containers must be a valid combo, and the otel-collector sidecar (0.25 / 0.5) pushed worker + sidecar to 2.25 / 4.5, over the 2.0 / 4.0 maximum. 1.75 / 3.5 totals exactly 2.0 / 4.0 (the max) and still clears the ~2.1 GiB OOM ceiling with headroom.
- bf49fd1: Give the temporal-worker memory headroom (2 vCPU / 4 GiB) and cap the V8 heap to stop the hourly OOM-restarts that were killing long Atlas/code-indexing analyses mid-run.

## 1.4.2

### Patch Changes

- 0c801fb: AI Update now incorporates the linked PM ticket's comment history (Azure DevOps, Fizzy, GitLab, and any MCP tool exposing a comments tool) so decisions and context captured in comments are reflected in proposed spec updates.
- 60aa29c: AI Update's terminal-state redirect is now retry-safe: a closed/hidden ticket update can no longer create duplicate tickets under slow-LLM retries.
- f72b7d2: AI Update redirects edits of closed/declined/hidden tickets to a new linked ticket instead of mutating them; deduplication now ignores terminal items.
- 6e08d3d: Fix Atlas codebase analysis failing on production with a raw "Authentication failed" error when the connected GitHub repo token had gone stale
- 82a5177: Story attachments are now overwrite-safe: uploads land on a temp key and are promoted to an immutable final key only after the row is reserved.
- 82a5177: Add a dedicated, AI-safe attachments section to the feature/bug editor (behind an opt-in flag): drag-drop/browse upload, list, download, remove (Unlocked-only), and lock/unlock — stored separately from the description so the AI Assistant cannot modify or delete them.
- 7e244f2: Restructure the feature editor into a tabbed sidebar (Details, Tasks, Attachments, AI Assistant) with a provenance Details tab and Fabric-only tags.
- cb5845e: Resolve all legacy lint, type-check, and format errors (44 lint + 18 type + 774 format) so the PR quality-gate runs fully clean.
- f3349a5: Feature Maturation: persist accepted-run change summaries as collapsed "AI Updates" notes in the Decision Log
- f3349a5: Feature Maturation: stop the AI re-asking answered questions and drop the placeholder's duplicate question list
- f3349a5: Feature Maturation: collapsible confirm-time change summary with click-to-locate
- f3349a5: Feature Maturation: collapsible Decision Log groups with a compact two-column layout
- 4c76dd7: Feature Maturation: clarify the Notes hint — the AI never reads _or_ edits it
- f3349a5: Feature Maturation: group open questions by topic on the Summary & Questions tab
- 1f1d4bb: Feature Maturation V2: answering an open question now resolves it in place (and tidy the Decision Log default).
- aaf7067: Feature Maturation V2: auto-populate the Summary & Questions tab on open so it's never empty.
- 10829b2: Feature Maturation V2: single configurable Clean Spec prompt + Refresh button, configurable/regenerating AI Summary prompt, staleness cue on context refresh, and soft-close reconciliation for stale questions.
- 7561a31: Feature Maturation V2: surface only the spec's stated questions, and show a change summary before accepting an AI run.
- fd0cda2: Feature Maturation: four follow-up fixes (AI update notes, answer→chat sync, rebuild-stage decisions, change-summary coverage)
- 908afb8: Feature Maturation: add the "X New Decisions" bar — a salient, cross-tab indicator of how many answered questions are recorded but not yet merged into the Clean Spec, with an Update CTA that batches them into one refresh.
- 90ba063: Feature Maturation V2: notebook realignment — questions come from maturation runs, answers flow through the spec, the editor keeps all its controls, and Tab 1 gains a human-owned Notes section.
- 90ba063: Feature Maturation V2: stop the question scan from resurfacing already-answered questions.
- 8c82ab2: Feature Maturation V2: open questions now surface in the Summary & Questions tab no matter how the spec was generated.
- dc5c42a: Feature Maturation V2 follow-up: separate bug/feature prompts (Summary + Clean Spec), route "Refresh Clean Spec" through the AI Assistant chat, and richer staleness cue (relative date + fill color + proactive pill).
- 8c82ab2: Feature Maturation V2: per-run change summary — review ~4 lines instead of a 1k-row diff after a maturation run.
- 38330cd: Feature Maturation: render the "Updated X ago" staleness indicator as a plain inline date label (clock icon + muted text) instead of a bordered, button-height pill that read as a clickable control. Severity is still conveyed by the colour-filled "Update using context" button beside it.
- 908afb8: Maturation V2: replace the five-stage editor bar with a To Do / Discovery / Done status picker and drop the Enhance button; show the same label on roadmap cards.
- aa7609f: Meeting auto-scan UI polish + accessibility fixes (follow-up to the scan-status feature).
- 34ed641: Meeting auto-scan: per-transcript scan-status view, a conflict toast when a proposal was already actioned, and an in-app transcript view + meeting date on meeting proposals.
- 70b32e0: Add a read-only full-page reader for project meeting transcripts in the Context tab
- 57d93e4: feat(newsletter): per-project embeddable release-notes widget — opt-in, themeable, with a revocable per-project token and double-opt-in subscribe
- 090b711: Paginate the project newsletter subscriber and unsubscribed lists, and refresh them immediately when the newsletter is enabled.
- d93da6e: Newsletter settings now show unsubscribed subscribers in a separate labelled block when revealed, instead of mixed into the active subscribers list.
- 2e09d11: Add user-configurable Notification Center preferences with per-category toggles, plus an admin-only weekly per-project service-alert digest.
- 127951b: Add per-user notification delivery preferences — opt in to email and signed webhook channels alongside the always-on in-app center
- ce7ecde: You can now open the existing feature referenced by an AI Update or Feature Proposal row in a new browser tab.
- 0fff8c3: PM sync: make the pull-side work-item-type → `StoryKind` reverse-map honour `FEATURE_PM_TYPE_MAPPING` from the runtime that owns the flag, instead of the Temporal worker's own environment.
- 2516de4: PM sync: resolve non-bug PM work-item types to FEATURE (not the retired USER_STORY), fixing an Azure DevOps pull crash.
- 5c2c514: Repair repository connections in place: each row now has Reconnect (GitHub/GitLab) and Edit-branch actions instead of delete-and-re-add.
- 0538377: Repository connections now self-heal: expired/errored repos return to ACTIVE automatically once their credentials work again.
- 3e2aaff: Stop the repo health check from firing a spurious credentials-expired notification when a connection is disconnected mid-cycle.
- aaf8feb: Report-run notifications now also email the run owner on completion and failure, with a per-user opt-out (Fizzy #1692).
- a616af9: Report runs now send an in-app notification on success and failure, so users no longer have to open the Execution History tab to learn a run's outcome.
- a3c516d: Reports: a removed data-source connection now prompts a manual reconnect ("Reconnect required") instead of silently switching to another connection.
- c900abc: Reports: self-heal a data source bound to a deleted/changed MCP connection to the user's current one, instead of failing every run and save
- 26caba3: Security scan: a single failed chunk no longer zeroes out a whole scan
- 8267e9b: Security scan: refine the findings list grouping, results bar, AI review dialog, and history
- b2f69ec: Security scan: ride out model rate limits instead of failing the scan
- 8b478b6: Security scan: scan one chunk at a time + larger chunks so large scans fit the model's token-per-minute quota
- 8bc3ca5: Fix Timezone field styling in the per-instance report schedule editor: stack its label above the control and match the other schedule fields' dark background.
- 5709baa: Scheduled reports now run automatically. A report template's Auto-generate schedule is inherited by its instances and fired by a new 15-minute Temporal Schedule, with timezone-aware next-run computation, idempotent dispatch (no missed or duplicate runs), and a one-time backfill for already-configured schedules.
- d3927b9: Add a per-report schedule control (Inherit / Custom / Off) so scheduled reports can be retimed or durably turned off.
- a738191: Security scan: confidence scores, cross-scan dedup, full-project coverage, an on-demand AI false-positive review, and a configurable severity rubric.
- d4ff617: Add the official Playwright MCP server to the registry seeders.

## 1.4.1

### Patch Changes

- 509364c: fix(deploy): force a unique revision suffix when rotating Container Apps for changed Key Vault secrets so the rotation can't silently no-op

## 1.4.0

### Minor Changes

- bf328c2: Add **Business Case** as a first-class AI-generated project document type (Fizzy #1450), alongside PRD and Proposal. Users can select it on the document-generation surface; it generates from project context via a dedicated, editable seeded prompt, is RAG-embedded, runs first in Phase 1 of "Generate All", and gets the title `Business Case — {project} — {date}`. Batch intra-phase ordering (Business Case leads Phase 1) is gated behind a Temporal `patched()` marker so in-flight `batchDocumentGenerationWorkflow` histories replay safely. Requires the new `BUSINESS_CASE` PostgreSQL enum migration to be applied and the `business_case_template` prompt to be seeded before use.
- 6900c91: Add **QA Strategy** as a first-class AI-generated project document type (Fizzy #1535), alongside PRD, Proposal, and Business Case. It generates a project-level Testing Overview from project context via a dedicated, editable seeded prompt (`qa_strategy_template`) and is RAG-embedded so future QA agents can reference it. A new per-project `Project.qaStrategyLevel` setting (`LIGHT | STANDARD | STRICT`, default `STANDARD`) scales document depth: LIGHT covers functional/acceptance testing only; STANDARD adds automated regression, security (SAST), and a browser/device matrix; STRICT adds DAST framing, performance/SLO, and WCAG 2.1 AA accessibility. The generator distinguishes "Enforced today" from "Recommended target" and routes unbacked requirements into a required Coverage Gaps section (STANDARD/STRICT) so the document is a roadmap rather than evidence of compliance. Depth is read inside the generation activity (not threaded through Temporal workflow input), so existing workflow command sequences replay unchanged. Requires the new `QA_STRATEGY` PostgreSQL enum value, the `QaStrategyLevel` enum, and the `Project.qaStrategyLevel` column migrations to be applied, and the `qa_strategy_template` prompt to be seeded before use.

### Patch Changes

- d77df51: Dashboard welcome widget now greets recently-added project members and lets project-only guests reach the home page
- c968d69: Fix: the in-document Fabric Agent now reliably sees the open document's sections
- 66e08d7: AI clarifying questions now surface as an in-chat answer card with clickable suggested options plus a "type your own" field, and a new project-level setting controls how often the assistant asks.
- fcc6607: AI-created proposals now show the proper bug/feature-prompt draft in the review the moment you open one — drafting no longer waits until you approve.
- cc884ea: AI Update now preserves the existing structure of a work item and makes targeted, type-aware edits — bugs stay bugs, features stay features — instead of rewriting the whole card.
- 0b1701a: AI Update structure-preservation now runs at the apply step too, so updates from every path — including the chat agent's "skip analysis" shortcut — preserve the existing work-item structure.
- 0548863: Speed up the AI Updates meetings source dropdown with client + server caching and background prefetch; repeat opens are now instant.
- 2cf05f0: Speed up AI Update meeting-transcript fetching: concurrent fetch + Microsoft Graph throttle backoff + per-user transcript caching (was strictly sequential).
- 7bcce05: Add an Architecture Decision Log ("Decisions" tab): capture architectural decisions with rationale, alternatives, participants, status, comments, version history, and AI context.
- 85b1cb7: Auto-analyze freshly-synced monitored meeting transcripts into feature proposals (opt-in per-project; reuses the existing AI Update analysis).
- 4707640: Blocked work items: clickable Blocked chip (edit reason / unblock), keep findings ↔ work-item views in sync, richer enforcement info
- 8b0fc92: Bulk sync to a PM tool is much faster: the per-item conflict check now reuses the capabilities discovered once for the run instead of re-discovering them for every item.
- a2f5f20: Bulk sync to a PM tool now aborts fast with a clear message when the PM tool is unreachable, instead of spinning for minutes.
- 7f3cfed: Bulk sync to a PM tool no longer reports a premature "Sync finished" — it shows the real synced / needs-review / failed summary (and the Review-conflicts shortcut).
- ffd8e52: Extend the clarifying-question card to the standalone Document Generator agent page
- c94dba8: Align the clarifying-question option number badge to the first line of text for long, multi-line options
- 213962c: Pre-fill the Prompt Library search from the `?search=` query param so the AI-settings "Customize these prompts" deep link arrives filtered
- 21ad45d: Fix the in-chat clarifying-question card rendering many duplicate copies for a single question
- 14123b6: Clarifying questions now reliably render as the interactive in-chat card, and the Prompt Library deep link arrives pre-filtered.
- aa0b331: Fix clarifying-question card answers failing the AI continuation with a 400 ("tool_result must have a corresponding tool_use block")
- 0cbe795: AI clarifying questions now reliably render as the in-chat answer card, and the per-tier question prompts are editable in the Prompt Library with a deep link from the project AI settings.
- 4dfe0b6: Stop the clarifying-question card from stacking duplicate copies (route the synthesized HITL action to graph end, not tool_node)
- 640562c: Fix project-context embeddings being silently marked COMPLETED when generation actually failed, defeating Temporal's retry policy
- b24ac16: Stop the document-assistant from opening a realtime SSE for conversations that don't exist, which spammed the console with repeated 404s.
- ca71981: Enable Custom Tags on every work item by default — remove the opt-in feature flag
- f9d6167: Add custom tags to roadmap work items: add/remove tags on the feature detail view with autocomplete, display them on the roadmap card, and filter the roadmap by tag with AND/OR logic. Tags are Fabric-internal and never synced to connected PM tools. Behind the NEXT_PUBLIC_FABRIC_FEATURE_CUSTOM_TAGS opt-in flag.
- 1bbd1d7: Architecture Decision Log: replace the meeting-candidate "Show more" reveal with a numbered pager (10 per page, Prev · pages · Next)
- b402919: Architecture Decision Log: review AI-detected meeting decisions in a preview before anything is written, page through long candidate lists, and see a current-vs-proposed comparison for updates
- 81eca86: Architecture Decision Log: explain where meeting suggestions come from — in the Decisions info popover and the feature doc
- 7039c07: Modernize the standalone Document Generator AI Assistant to match the project editors (panel chrome + session history) and fix the toolbar bleed-through
- 30cea92: Fix Document Generator chat history never persisting (so the history drawer stayed empty)
- 30cea92: Fix the Document Generator editor toolbar bleeding through the top of the AI Assistant panel
- c68f466: Fix the docs marketing footer being overlapped by the fixed documentation sidebar at the bottom of the page.
- 9dfebab: Fix docs integrations footer-nav descriptions clipping to one line when the sidebar is open.
- e03dc7e: Add Security & Accessibility Scanning documentation (user guide, architecture reference, and ADR)
- 200dc2f: Fix: the Fabric Agent (page copilot) now sees the full content of the feature/document you have open
- c4afec9: Fabric Agent reads across all relevant project documents, streams live progress on long answers, and degrades gracefully if the Nexus page errors
- adf873e: Fix a cross-workspace data-isolation gap: three org-scoped queries cached their results under a workspace-agnostic key, so after switching workspaces they could briefly surface the previous workspace's data.
- 242b506: Surface failed AI document generation in the editor (Fizzy #1450, AC-7). When a document's generation fails, the row is persisted with `status = "FAILED"` and a `generationError`, but the editor previously rendered the empty content as a normal saved document with no indication of failure. The editor now shows a `DocumentGenerationFailedNotice` with the server-provided reason and a Regenerate action when the persisted status is `FAILED`.
- cb5a64a: Fix Fabric Agent failing with a generic error ("Workflow execution failed" / "No output generated") on complex requests when many MCP servers are enabled. The real provider error is now surfaced, the MCP tool payload is validated and capped before the model call, the turn retries once without tools on a tools-related failure, and "Suggested next actions" no longer render on errored messages. (Fizzy #1644)
- 08b7eb5: Fix the invite redirect loop that blocked switching to a different account while already signed in.
- 0cff644: Reclaim stale newsletter sends with a dead workflow id so Send now self-heals after a Temporal worker outage
- 8e19334: Give scan findings meaningful titles when the AI model omits them
- 22eb345: Make the scan findings schema tolerate fields the AI model omits
- 2ed3bfc: Fix security & accessibility scan schema being rejected by the AI gateway
- 7163f33: Fix security & accessibility scans failing when the AI model returns non-canonical severity labels
- 595d22e: Fix Slack huddle-notes ingestion silently failing on the Temporal worker
- e905e15: Fix newsletter unsubscribe link returning 404 by bypassing locale middleware for /unsubscribe
- 436ced8: Fix GitHub repo integrations dropping to TOKEN_EXPIRED by serializing single-use token refresh and stopping the background health-check refresh
- 5a15480: Fix: the Bug/Feature toggle and the in-review draft now work in the monitored-sources proposal inbox — it was silently doing nothing because the inbox didn't pass projectId to the proposal review.
- 0183037: Show a "drafting…" banner in the proposal detail while a Bug/Feature switch (or the on-open draft) is reformatting, so the ~minute-long LLM draft no longer looks frozen.
- c1c82e7: Fix the Loom up-front clarifying question never firing (the surface tag wasn't sent to the workflow)
- 63a4086: Fabric Agent (Loom) planner mode now asks a per-step clarifying question for any planned step whose intent is ambiguous, before that step runs
- 579bf56: Fabric Agent (Loom) now asks one clarifying question up front when a request is materially ambiguous, before committing to a multi-agent plan
- 1975a89: Add the Feature Maturation V2 data model: threaded Decision Log, per-tab approval preferences, and working-notes columns (additive, inert until the editor ships).
- 1975a89: Lay Feature Maturation V2 groundwork: an org-level opt-in flag (default off) and the scoped spec-patch propagation core — both inert until the editor ships.
- 1975a89: Add Feature Maturation V2 non-gated backend: three-tab editor state, threaded Decision Log, and per-tab approval modes
- 4aa7ed5: Feature Maturation V2: auto-propagate confirmed decisions into the Clean Spec as scoped patches (flag-gated, inert by default)
- 1975a89: Add Feature Maturation V2 three-tab editor shell behind the org flag, with a session v1/v2 toggle
- dadf076: Keep Meeting Transcript Sync meeting-row metadata fully visible on narrow screens
- ca25494: Reflow Meeting Transcript Sync meeting rows on narrow screens so the name and metadata stay readable
- 8605cbb: Redesign the Meeting Transcript Sync settings card and theme the project settings section headers
- 459ac56: Make workspace switching (and every page load) much faster by prefetching sidebar routes on hover/focus instead of eagerly for every link.
- 5b71def: Add a configurable newsletter lookback window (per-project "Lookback window (days)")
- c84f14a: Newsletter email matches the design mockup: filled grey version pills, project-scoped unsubscribe notice, and an arrow on the Open Fabric button.
- 2057f83: Newsletter: in-app member-facing Release Notes page
- 1b8058a: Newsletter: auto-enrol project members as release-notes subscribers and add privacy/terms links to the email footer
- 92729eb: Newsletter: public Release Notes archive on fabric.pro
- 507e952: Public newsletter opt-in (double opt-in): visitors can subscribe to the Fabric release-notes newsletter from the homepage and the public /release-notes page, confirming via an emailed link before joining the list.
- 686b305: Newsletter now sources release notes from published production releases (v\* tags) instead of production-branch-merge PRs.
- 9ae264c: Add an external-stakeholder release-notes email newsletter: per-project subscriber list and configurable cadence, AI-curated major-feature summaries, manual "send now" plus an hourly scheduled dispatcher, with one-click unsubscribe.
- cd8852f: Newsletter send history now shows human-readable statuses and warns when a project's repository credentials have expired, instead of an opaque SKIPPED_EMPTY.
- 84ce7b5: Redesigned the release-notes newsletter email (warm-paper editorial style, release-grouped highlights with version badges, no raw links) and made the send history paginated with a status filter.
- 4e26e92: Add a webmaster embed kit: a copy-paste iframe snippet on the public Release Notes page lets external sites host the Fabric newsletter double opt-in signup form.
- 85bbd39: Scope the attached-document similarity-floor bypass to chat surfaces so the v1 knowledge API keeps its relevance threshold
- 46936f8: Improve image and short-text attachment handling across all AI surfaces
- 9a26bdb: Fix Nexus document attachments: explicitly-attached files (PDF, Markdown, etc.) are now always readable by the AI regardless of question-to-content similarity
- 0754176: Nexus now shows attached images to vision-capable models, not just a text description
- 4c81c18: Speed up Projects, MCP Servers, Workflows and the dashboard by removing redundant queries and runaway polling.
- 06b968f: Proposal drafts are now generated once on the server and shared with your whole team — with a live counter, cancel/restart, a per-project "pre-draft on open" toggle, and verbatim create.
- 005708a: Cap simultaneous persistent error toasts at 10 with replace-oldest overflow, so a burst of failures can no longer pile up unbounded.
- 0b96f7b: Fix two roadmap clicks that opened inside an installed PWA's standalone window instead of a regular browser tab when the user had the destination PWA installed:
- fb48784: Fix PM sync table and code-block round-tripping for Azure DevOps and Fizzy
- 2654347: PM sync: add a flag-gated (`FEATURE_PM_TYPE_MAPPING`) work-item type mapping layer between Fabric `StoryKind` (Bug / Feature / User Story) and external PM work-item types (Azure DevOps this increment). Behavior-preserving when the flag is off or no mapping is stored — the immediate effect is correct `StoryKind` classification of newly imported items. A pure resolver in `@repo/utils` is consumed by all three push-create surfaces and the pull-create surfaces; reverse mapping is create-only with a drift-log warning on re-pull of existing stories. Jira `issueTypeName` mapping, ADO multi-backlog pull discovery, and the mapping UI/AI remain follow-ups.
- 03208a5: Proposal drafting is now an explicit "Draft with AI" action — no per-project toggle, no auto-draft-on-open — and tickets are always created through the type prompt, with PM sync only firing after the draft is done.
- 458f24a: Remove dead test-mock references to the dropped `predraftProposalsOnOpen` project column (test-only; no behavior change).
- a63020a: Fix RAG retrieval embedding on the wrong tenant's provider when organizationId is dropped — resolve the tenant from the project
- 0fca8d5: Fix the document-assistant realtime SSE 404 retry loop for org conversations by deriving the tenant from the conversation instead of the (often-null) session active org.
- f1fe580: Let teammates receive realtime updates on SHARED document-assistant conversations (fixes a 404 retry loop on shared documents).
- 8ef5be6: Remember last active organization or personal workspace across login sessions.
- 4d57c15: Remove the throwaway Slack huddle-canvas extraction PoC
- 595d22e: Remove the throwaway Slack huddle-ingest diagnostic endpoint
- 4ac8ed3: Reports instance page: un-hide the wired Fabric AI Enhancement (drop stale "Coming soon") and replace the native delete confirm with an in-app dialog
- 7052647: Redesign the Report instance page into a focused two-column workspace with a sticky readiness rail and clear banners for connection/config issues
- 1ee8b7e: Reports: surface the full two-step connection-recovery flow and replace raw error strings with plain-language, actionable guidance
- d4b61fb: Review Center: add a Dismiss action to conflict rows so a deleted-PM-card conflict can reach a terminal state.
- 0b63a1b: Review Center: clear stuck failed syncs with a new Dismiss action, and surface the Unlink/Re-push recovery for deleted-PM-ticket items.
- 780235b: Roadmap: replace the tall project hero with a compact header and a slim, explainable stats line so the work-item table leads the page.
- 06b513b: Roadmap: the "Project Roadmap" header label now uses the project's primary theme color (via the shared app editorial-label) instead of a hardcoded marketing-red, so it matches the active theme in the strip and the About popover.
- 31408b3: Roadmap PM-sync & panels: batch sync now routes conflicts to the Review Center with a clear per-item summary, "Also sync to PM tool" works for all users, and the side panels open faster and scroll smoother.
- 939e78f: Roadmap performance: memoize the story/status transforms and React.memo the row cards so unrelated re-renders don't re-render every row.
- 6a32c1b: Redesigned project roadmap — table/board/plain views with saved per-user layout & ordering, bulk actions with undo, richer filters, and a Hidden stage facet.
- 196be9b: Security scanning: Block enforcement mode now auto-blocks work items tied to findings
- f0c0a5d: Work-item Blocked flag: align permission, refresh the roadmap from a finding-block, and add unit coverage
- eb11e12: Work items: Blocked flag (with version history) + block findings against existing features; remove "convert to work item"
- 24da67b: Security & Accessibility scanning: let users override a finding's status, category, and severity
- 6ed451d: Scope the security & accessibility findings list to the latest scan so re-running a scan replaces results instead of stacking them
- fc2ad64: Security & Accessibility scanning: incremental "Scan" vs "Full scan", git-history secret scanning, and scan telemetry in History
- 383ade8: Security & Accessibility scanning: source links to verify findings, split History, git-history as 4th scanner, and clearer enforcement
- 916c17e: Detect outdated frontend builds after a release and seamlessly upgrade users to the latest version without a disruptive hard refresh.
- 0afc100: Frontend auto-update is now fully silent on normal releases; a one-minute countdown banner appears only as a backstop after 10+ minutes stuck on a stale build.
- 8a0f70f: Add AI security & accessibility scanning agents that surface OWASP and WCAG 2.1 AA findings on a per-project page
- 9a7b843: Security & Accessibility scanning: redesigned results, convert findings to work items, page history, real Semgrep SAST, and secret redaction
- 5f528a4: Security & Accessibility: run a scan with only the repo scanners on, survive a sub-scanner timeout, and show each finding's source scanner + a live run timer
- b9c68ca: Give every icon in the collapsed sidebar a consistent hover tooltip and straighten their alignment.
- 90e5ede: Center the collapsed-sidebar logout icon so it lines up with the rest of the rail. The logout control is a `<button>` (which doesn't stretch like the `<a>` nav items), so it sat a few pixels left of the column; making it full-width centers it.
- 79e7a08: Fix sidebar nav on the System theme and when collapsed: Workflow/MCP icons stay visible, the workspace shows as a circular avatar, and the sidebar can be expanded on fullscreen pages.
- 06b4d81: PoC (#1634): inspect full huddle-transcript body for embedded transcript text
- 5325c86: PoC (#1634): follow huddle_transcript_file_id to fetch the verbatim huddle transcript
- 34f6fc2: PoC (story #1634): probe whether Slack huddle-notes Canvas content is reachable via bot-token APIs
- 7a46be6: PoC (#1634): extend huddle diagnostic to trace the store step
- 4877c5b: PoC (#1634): throwaway diagnostic to trace Slack huddle-notes detection
- 37d29ac: Ingest Slack huddle AI-notes into AI Updates (Teams transcript parity)
- bba9992: Reports: the readiness rail is now genuinely sticky and identical across the Overview and Execution History tabs
- fdf91c4: Bulk sync to a PM tool no longer shows a false "Sync failed" when a single progress poll hits a transient error.
- a5e9a99: Fix the Temporal worker crash-looping on boot (`Cannot find module '@repo/config'`) by copying the `@repo/i18n` manifest into the worker image.
- 6c368f8: Fix project newsletter sends failing by wiring RESEND_API_KEY into the Temporal worker so worker-originated emails actually reach Resend.
- 3c5a30f: Workspace switching now shows an inline loading state, ignores repeat clicks while a switch is in flight, and navigates faster.
- e58ad11: Harden the workspace-switch loading state so it can never get stuck and announces reliably to screen readers.
- b81e90a: Make workspace switching navigate optimistically so clicking elsewhere mid-switch no longer bounces you back to the old workspace.

## 1.3.7

### Patch Changes

- c9c86fd: Move the deploy pipeline's Docker layer caches from GitHub Actions cache to ACR registry caches (`:buildcache` tags) — GitHub's 10 GB cache pool cannot hold the full 13-image set (~13–15 GB), so warm builds were eviction-lottery; ACR has no such cap. Skip Vercel builds for the bot-managed `changeset-release/*` branch (it is force-pushed after every master merge and its preview is the already-deployed master plus version strings — ~900 wasted Enhanced-machine minutes/month). Add a weekly ACR cleanup workflow that deletes image tags older than 30 days while keeping everything referenced by active Container App revisions (the dev registry runs legacy apps on months-old tags), `latest`, and `buildcache` — the dev registry had accumulated ~3 TB of unreferenced images (~$270/month of storage overage).
- 2848f31: Purge "user story" terminology from the agent-framework, MCP server, and seeded-agent generation layer — they now describe and produce Features.
- 6fbd532: Improve the roadmap change-history window: ticket-ID open-in-new-tab, change-source labels, a page indicator, and date + person filters.
- 4063fed: Add a read-only AI Backlog change history with two tabs in the proposals drawer: "Session history" (AI Update runs with author, time, status, and proposed changes) and "Audit" (backlog item changes — created/updated/moved/deleted — attributed to AI vs. a teammate, with timestamps).
- 21f7094: Harden the AI Backlog change history: personal-project AI audit visibility, no stuck "Applying…" sessions, actor email fallback, plus dark-mode/a11y/responsive polish.
- 271cbf9: Relocate the AI Backlog change history: a searchable roadmap Audit window, and Session history (with the conversation) moved inside the AI Update window.
- 92a5992: AI chat: show a live spinner on the "Thinking" reasoning trace while the agent is still working.
- 7ea33b8: AI Update apply no longer fails the whole run when a story's linked PM ticket was deleted in the PM tool.
- c765272: AI chat: show a live "Thinking…" spinner while the agent is working, before the first reasoning/response token.
- dd04795: AI Update apply: a PM-sync content conflict no longer fails the whole proposal; the Fabric change applies and the drifted items route to the Review Center.
- 341c6c3: Fixed AI Update referencing work items that could not be found via search.
- ee98074: AI Update result card: link each applied ticket to its detail page, opening in a new tab.
- 7f893ab: AI Update Session-history detail: right-align the run time, and clearly mark a deleted ticket in the results.
- fdfd2f4: AI Update Session history: header button, live status, read-only conversation replay, and linked result cards.
- a04849c: AI Update Session history: link a session's tickets even when the create's audit row wasn't tagged with the proposal id.
- 1d01854: Remove the disabled "Read-only" composer from the AI Update Session-history detail view — it served no purpose (the view is already clearly read-only).
- 2af5f48: AI Updates: surface per-item Skipped and Failed outcomes in the accept result summary, with screen-reader announcements.
- 3325dec: Ground Atlas chat in cross-repository references and edge descriptions, with explicit reference citations.
- 63afd86: Atlas: stage structural graph edits with Save/Discard, draw connections by dragging with a type + description editor, and re-type existing connections.
- 26fb3e1: Atlas: self-healing repo credentials, monitored-branch editor, unified assistant, floating node details, loss-proof chat history.
- 4a4d4db: Atlas System map: sharpen cross-repo references so the microservices map is correct and meaningful — AI links now require a confidence signal (low-confidence dropped; vague "shared domain" kept only when high-confidence) and the prompt rejects superficial similarity, plus a deterministic DEPENDS_ON when one repo depends on another's published package.
- 3325dec: Atlas: persist System-map node layout and make connections editable, manual, and soft-deletable with history.
- 8b79b2b: Atlas: grouped + paginated chat & analysis history, non-interactive graph edges, and read-only category chips with hover explanations
- d814108: Atlas: add a multi-repository "System map" that shows connected repositories together with cross-repo relationships and answers Q&A across them.
- 63afd86: Atlas: add "Re-map relationships" to regenerate AI-derived connections on demand (solo graph + System map), with keep-my-edits and fresh modes.
- 684988e: Atlas: LLM-categorized graph, per-run analysis cost/token telemetry in History, editable node descriptions & categories that feed the AI, branch picker, non-blocking re-analysis, and a redesigned graph + overview.
- 08eb1d3: AI Update: cancel a backlog apply that's stuck "Applying…", plus an automatic watchdog that recovers proposals stuck mid-apply past 15 minutes.
- c94cc24: Daily Brief now collects releases and pull-request activity from GitLab and Azure DevOps repositories, with GitHub behavior unchanged.
- 650ea7d: Daily Brief: latest production release anchor now shows one per connected repo (multi-repo projects see every repo's current prod release).
- 8b9adb9: Daily Brief: show full GitHub release notes and surface the latest production release.
- 2848f31: Purge "User Story" terminology from document-generation prompts — generators now emit Feature (`F-XXX`) leaves with a `Description` section, and a migration rewrites already-seeded prompt rows.
- 9bea551: Duplicate scan completion now opens a summary dialog with a one-click "View Duplicates" filter instead of a transient toast.
- 596c836: Duplicate scan is now incremental (only new/changed items are re-embedded and re-verified) and the completion modal reports the flagged-item count.
- 31a8131: Speed up frontend builds on Vercel and in the prod deploy workflow:
- 7b88f80: Fix AI document edits corrupting tables and stripping in-cell bold by unifying the editor markdown serializer across all three editors
- 52dfcf0: Fix the AI Backlog Update panel (and other CopilotKit default-header surfaces) rendering a white header strip in dark mode.
- 4d4a198: Fix multi-tab refresh hijacking a tab into another tab's org/page state
- 1f79e20: Fix the cropped action bar and unreadable title/description in the prompt preview panel.
- d73a626: Daily Brief now surfaces published GitHub Releases in a new Deployments section
- 303df8c: AI Backlog history dialogs (roadmap "Change history" + AI Update "Session history"): uniform row heights, a wider window, and hover-to-reveal full text on truncated titles.
- 32e1ccc: Add a "New Project" welcome widget to the dashboard that surfaces your most recent pending project invitation with one-click open, persistent dismissal, and a link to view all invites.
- fe799fa: Notifications: clicking a notification now always opens the project workspace of the notification's own organization (Fizzy #1528).
- f7d264c: PM-sync: collapse content-drift notifications into one per project so a bulk external edit can't flood the notification bell
- 52b28d5: PM-sync: baseline content-drift detection from what the tool STORED, not what we pushed — stops re-rendering tools (Fizzy/Asana/Monday) from false-flagging every synced item as drift
- 632c00a: PM sync (GitLab): round-trip images & file attachments on import/pull and push, and stop failed-pull placeholders from clobbering the source.
- 42b40ad: PM sync: pull images & file attachments from ADO/Fizzy/GitLab into stories and fix the push round-trips (line breaks, attachments, image re-ingest)
- 5908ed6: Truncate over-long work-item titles to the PM tool's limit before pushing, fixing an opaque "Fizzy API error: 500" that permanently stranded features/bugs with long titles.
- 244201e: Review Center: explicit Unlink/Re-push/Dismiss recovery actions, a retry fix, cross-tab dedup, "Sync Drift" rename, tab tooltips, and bulk Failures-retry.
- eab4524: Repository settings: remove the internal "Code search not configured" warning from the code-search toggle
- 826a405: Remove the "Suggest with AI" button from the project terminal-status editor.
- 62355bf: Add two repo-integration credential-health alert rules (worker GitHub OAuth app credential rejection + >50% unhealthy ratio), querying the worker's Log Analytics console logs.
- 59a1534: Fix generated board reports rendering with a dark theme in Fabric light mode by enforcing a fixed, self-contained light theme.
- 0b2b32d: Verification emails can now be resent directly from the post-signup and invitation "check your email" screens, with a 60s cooldown armed from the start.
- 2848f31: Retire "User Story" as a Fabric work-item type — AI generation, proposals, roadmap, prompts, and PM-tool mappings now use only Feature and Bug.
- 97e14cc: Roadmap Change-history: mark deleted tickets and group bulk changes.
- 6af8f26: Fix roadmap search so multi-word queries match regardless of word order
- 226cf7f: Sync the SYSTEM prompt seed with the latest production prompt content (15 prompts) so a fresh database seed matches what production serves.
- 9ea4f28: Fix long selected values overflowing the select trigger and overlapping the field label and helper text (e.g. New Plan "Link to Feature").
- 68eaa07: Pending invitations now auto-resolve once the email is verified, every invite signup requires real verification, and guests get a Shared with me section.

## 1.3.6

### Patch Changes

- 6a114b8: AI Update features now appear on the Roadmap, and the pending-proposals inbox no longer mislabels AI Update runs as monitored-channel proposals
- 25421ef: Add a maintenance script that migrates stranded Feature-container rows into roadmap-visible feature cards
- b0ee6b9: Unify the conflict-modal timestamp word order across the Fabric and PM-tool columns.
- de32ed8: Fixed resolved PM sync conflicts leaving a stale conflict pill on roadmap tickets and a lagging Review Center count.
- 78aa32d: Consolidate work items into a single user_story table: drop the legacy epic/feature folder tables so the roadmap has one source of truth and items can never be split across invisible containers.
- 5c18c42: Error toasts now persist until dismissed instead of auto-closing after a few seconds
- 30c13c7: Surface the Fizzy ticket's last-changed date in the PM-sync conflict dialog.
- 24db74c: Fix PM-sync pull capturing Fizzy's internal id instead of the addressable card number, which made every later push 404 ("Resource not found").
- 11f5111: AI assistant: hide the redundant success operation-result card from the chat thread
- e60795f: PM sync failure panel: Retry now re-creates a deleted PM card, with clearer "card missing" copy and a disabled-with-reason "View in tool" link.
- 96336bd: PM sync: the failure panel now offers "Push & relink" for a tool-mismatch instead of a dead Retry.
- 8efa766: PM pull UX: show "• marked done" toast on checkmark-only sync; PM auto-push/auto-close settings toggles now flip instantly with rollback.
- 6999f94: PM sync (editor): collapse the cloud toggle + status badges into ONE chip with a dropdown of actions.
- 77372bc: PM sync (editor): fix the chip stuck on "Syncing…", drop the manual refresh button + spinner, collapse the "PM card missing" chip into "PM sync failed", and show the PM-tool link only when synced.
- 789b9f8: Bring the feature editor to PM-sync parity with the roadmap card via a shared `PmSyncControls` cluster.
- b1e9403: AI-Update pushes to a deleted PM card now propose a one-click unlink instead of failing silently, and Review Center rows link out to the PM tool.
- ddadc1f: The PM-sync failure panel now offers a one-click "Unlink & re-create" for a deleted PM card, and the confusing "Needs re-link" chip is removed.
- edb7879: Fix "View in PM tool" / the synced cloud icon opening a blank tab — open the linked ticket directly.
- 663a77d: Per-item "Pull from {tool}" now also runs the PM terminal-status reconcile for that story (checkmark + hide/unhide per Auto-close), across MCP and GitLab-REST sync paths. Pull no longer unlinks a story whose linked ticket is not found when the link has a known PM server (deletion stays owned by the scheduled poll's human-reviewed flag); legacy links with no recorded server still self-heal. Transient sync errors never unlink.
- 3c9faaa: Weave: cancelling a run during its final step now restores the plan instead of leaving it stuck in Running.
- e0819ec: Weave: add a "Cancel run" button to the execution monitor, and restore the plan to Approved instantly on cancel.
- dfc2a3d: Weave: cancelling a run reliably restores the plan, and a finished run no longer leaves the plan stuck "Running".
- c6e7718: Weave: cancelling a Background Agents run now stops it promptly, and plans can be deleted.
- d3d7dbd: Plan with Weave no longer fails silently — unreachable services surface clear errors, failed runs are marked Failed, and plans can be retried.

## 1.3.5

### Patch Changes

- e1272d4: Align the Review Center content-drift modal with the roadmap conflict modal, and show absolute timestamps.
- 059eb16: Monitored Slack/Teams channel proposals now flag genuine near-duplicates as "Possible duplicate" on approval while remaining create-only.
- 9a9b54f: Align the PM-sync conflict dialog columns by giving the PM TOOL side a source row so both columns share the same header height.
- 0b5d6f8: Add Confluence as a first-class project context source — pages can now be imported into project RAG, AI Backlog Update, and the feature-editor "Update with context" helper, the same way Notion works.
- adeb2fb: Fix "Add Confluence context": support Atlassian Rovo's MCP tools so the page picker lists spaces/pages instead of erroring with "Missing required tools".
- 6f6681e: AI assistant error toasts now stay on screen until dismissed instead of auto-vanishing after a few seconds
- 0679592: Give the duplicate-merge dialog far more room to read each ticket by compacting its header and surfacing metadata clearly
- e59fb61: Fix the duplicate-merge dialog's metadata tooltip (values were invisible in both themes) and add a hover explainer for the similarity/match-confidence score.
- 889e09f: Conflict comparison dialog now shows the Fabric author, the change source, and a per-column word count.
- 059eb16: Feature work items now sync to flat PM tools (Fizzy, GitLab, Linear, Jira, etc.) on AI Update apply — previously only bugs synced.
- b61fe87: Harden the invitation-only signup gate to also accept project invitations, so external project-only invitees can still sign up when global signup is disabled.
- ddd06f5: Keep the PM-tool dropdown in place when editing the Project Management Integration.
- 919f4f7: Clear a stale "PM sync failed" badge when a single-story push succeeds.
- 518cefe: Fix unreliable PM-tool sync: org-wide GitLab connection resolution, concurrent-sync de-duplication, external-link write retries, and a cross-tool "needs re-link" status.
- 059eb16: Feature proposal review: the "Type changed from AI suggestion" indicator now only appears when the chosen type actually differs from what the AI suggested.
- e35ab0d: Remove the redundant "Sync Failures" banner from the project Roadmap.
- 1ebfa93: Report generation now reports which data source failed and why, runs on healthy sources instead of failing instantly when one MCP server is down, and offers a Reconnect action.
- b2b820f: Review Center groups PM-sync work into Conflicts / Failures / Pull Drift tabs with accurate per-category counts.

## 1.3.4

### Patch Changes

- 7faee9c: Pull images from Azure DevOps tickets into Fabric on import/sync instead of showing broken image icons.
- 7faee9c: Atlas chat: a smarter assistant that cross-references the code and the business view instead of deflecting
- 7faee9c: Atlas: re-attach a previously-analysed map when a repo is removed and re-added, and move History beside Re-analyse
- 7faee9c: Atlas: keep a previously-analysed map viewable when repo credentials lapse, notify on expiry, and refine the Overview dashboard
- 7faee9c: Atlas: polish chat readability, conversation labels, graph controls, and add a "How Atlas works" popover
- 7faee9c: S3 storage provider now falls back to the AWS default credential chain when static S3 credentials (`S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`) are not configured, enabling IRSA (IAM Roles for Service Accounts) authentication for in-cluster pods. Part of adding AWS EKS deployment support (Terraform infrastructure + Helm chart + GitLab CI/CD pipeline).
- 7faee9c: Fix backlogApplyChangesWorkflow replay nondeterminism by guarding the Step 6 operation-result activity behind a patched() marker.
- 7faee9c: Add an operator-run backfill that enrolls existing PM-linked story/epic/feature rows into FLAG_MISSING by stamping externalMcpServerId only on verified org/tenant matches.
- 7faee9c: Monitored Slack/Teams channel feature proposals now only create new work items — duplicate detection and "update existing ticket" suggestions are reserved for the AI Update flow.
- 7faee9c: Add a "Understanding" project tab that analyses a connected repository into an interactive, AI-described dependency graph with Technical and Business lenses and a graph-grounded AI chat (behind a default-off feature flag).
- 7faee9c: Atlas (Code Understanding): add a Cancel-analysis button, raise the analysis timeout to 5h, and shrink the repo clone so large monorepos fit constrained workers.
- 7faee9c: Run Code Understanding analysis on its own dedicated Temporal task queue + worker.
- 7faee9c: Duplicate-merge dialog: per-ticket metadata, attachment preservation on the kept item, and a "Declined duplicate" chip on the closed discarded item
- 7faee9c: Fix Fizzy PM-state detection (#1360): detect card closure via the `closed` boolean and the kanban column, and surface deleted-card FLAG_MISSING by unwrapping the MCP `{error}` shape that was being lost as "[object Object]".
- 7faee9c: Detect deleted non-ADO PM tickets structurally in the FLAG_MISSING poll instead of fabricating phantom work items.
- 7faee9c: Fix blank PM-tool conflict diff for non-creators and show why when a PM connection is missing or expired
- 7faee9c: PM sync conflict dialog: per-column "last changed" reference line, and AI-merge no longer 400s on a stale client.
- 7faee9c: PM sync AI merge now reconciles the title alongside the description, and its prompt is configurable via the Prompt Library.
- 7faee9c: Show the connected PM tool's name (e.g. "GitHub", "GitLab") in the roadmap and proposal "Also sync to {tool}" checkbox even when the current user's PM connection can't be resolved, instead of the generic "PM Tool".
- 7faee9c: Add a "Sync to PM tool" checkbox to the monitored-channel feature-proposal review (off by default), giving reviewers explicit control over whether an approved Slack/Teams proposal pushes to the connected PM tool — consistent with the AI Update flow.
- 7faee9c: Review Center conflict dialog now shows the Fabric "Updated {when}" timestamp instead of the "date unavailable" fallback.
- 7faee9c: Auto-dismiss stale FLAG_MISSING proposals when a PM ticket reappears, and make both Accept routes consume the pending row atomically so a reappeared ticket can't be wrongly unlinked.
- 7faee9c: Keep the diff mode toggle (inline / side-by-side / full preview) and accept/reject bar pinned to the top while reviewing long documents
- 7faee9c: Keep the conflict and duplicate modal action buttons visible without scrolling by pinning them in a sticky footer while only the content scrolls
- 7faee9c: Fix Temporal worker crash-loop on startup by adding `@repo/code-understanding` to the worker Dockerfile's dependency-install scope.
- 7faee9c: Upgrade vitest 3.2.4 → 4.x and align the test suite with its breaking changes.

## 1.3.3

### Patch Changes

- 7acc31a: Show the body of bugs pushed to Azure DevOps (write to Repro Steps, not just Description)
- 970861b: Push ADO bugs as the "Bug" work-item type, and surface the real PM-tool error on a failed create
- 293eed9: Let users close and reopen the AI Assistant chat panel in the Feature and Document editors
- efc708c: AI Assistant chat: action buttons under AI messages no longer overlap the message timestamp, and the timestamp hover tooltip now shows the reader's local time instead of UTC
- 47b3d38: Add a Copy Link button to the work item editor that copies a rich-text hyperlink to the clipboard in a single click
- d820691: Fix status chips (Needs More Info, Possible Duplicate, and others) that were unreadable in dark mode
- c7a7b34: Fix AI Backlog Update failing to create features and epics when "sync to PM tool" is enabled
- 555381b: Roadmap filter toolbar count now reads "N work items" instead of "N features", matching the type-agnostic roadmap labels.
- f6ac810: Roadmap now uses the type-agnostic term "work item" instead of "Feature" for counts, empty states, and actions, so projects containing Bugs read correctly.
- 0e419b4: Fix search provider usage counts not incrementing in Settings.
- b9f6bb3: Fix "View in Fizzy / View in PM tool" links on backlog story cards opening inside the linked PM tool's installed PWA (e.g., Fizzy.io desktop app) instead of a regular browser tab. Applied the same programmatic anchor click pattern used for the in-Fabric "Open in new tab" action: the click handler creates a transient `<a target="_blank" rel="noopener noreferrer">`, calls `.click()`, then removes it — Chrome treats this as user-initiated link navigation that is not captured into the destination PWA's standalone window. Covers the PmSyncCloudToggle brand icon, the "Open ticket" affordance inside its tooltip, and the kebab-menu "View in {pmToolName}" entry. Right-click and middle-click on the underlying `<a href>` are unchanged.
- 526cf9d: Fix Jira nested-fields / ADF handling across PM-sync read paths
- 6d4e6e4: Fix Jira (Rovo) pull no-op (false "Success") and save/auto-push "does not have required capabilities"
- 17314e3: Fix Jira (Rovo MCP) push failing with "createJiraIssue: cloudId / issueTypeName Required"
- 00b1328: Duplicate merge now surfaces and handles linked PM-tool tickets, so a sync connection is never silently lost when you merge two work items.
- 9181abb: Rename the PM terminal-status poll pipeline's internal ado* identifiers to pm* (durable names deferred)
- 4061c7f: PM sync: epic/feature now carry externalMcpServerId into the push-side mismatch guard, so cross-tool migrations hard-block instead of silently mis-syncing to a foreign PM tool.
- b5f03cd: Fix "View in Fizzy / Jira / Azure DevOps" links on backlog story cards opening inside the linked PM tool's installed PWA (e.g., Fizzy.io desktop app) instead of a regular browser tab. Chrome's cross-origin PWA capture intercepts declarative `<a target="_blank">` clicks, programmatic anchor clicks, and `window.open` calls when the destination origin has `capture_links` enabled in its installed PWA manifest. The only reliable source-side bypass is to open `about:blank` first — a same-origin `about:` window that no installed PWA can claim — and then assign `location.href` to navigate the new tab to the ticket URL. `w.opener = null` severs the backref so the opened tab cannot manipulate this one via `window.opener`, preserving the security guarantee normally provided by `rel="noopener"`. Covers the PmSyncCloudToggle brand icon, the "Open ticket" affordance inside its tooltip, and the kebab-menu "View in {pmToolName}" entry.
- 4061c7f: PM terminal-status: single-row Accept of EPIC/FEATURE HIDE, UNHIDE, and FLAG_MISSING proposals now applies instead of being dismissed.
- c1002c6: Detect deleted PM tickets and flag the orphaned story for unlink
- 55ac81d: PM terminal-status: unify "Closed/Close/Re-open" UI vocabulary to "Hidden/Hide/Unhide" and add a "Last synced" staleness indicator on the project's PM settings card.
- c4fffec: PM terminal-status: auto-unhide (or propose unhiding) a story when its PM ticket is reopened after being auto-hidden.
- 8ee1629: Soften the dark-mode Roadmap attention chips (Needs More Info, Possible Duplicate) to neutral muted-gray text instead of near-white
- c89e862: Detect deleted Azure DevOps tickets structurally via batch silent-drop (activates ADO FLAG_MISSING, was inert under the permission veto)
- c7da1d3: Fix cropped Restore/Compare action buttons on version-history cards in the Feature and Document editors

## 1.3.2

### Patch Changes

- 6d487bb: Fix the Add Context dialog cropping its content on the right at narrow viewports
- b2c0848: Widen the Add Context dialog so all seven source tabs fit on one line
- 1783f91: Reveal full text in a tooltip for truncated labels in the project setup Add Context step
- 2ff1d93: Keep system admins in their current workspace when using the Admin area
- a9c0816: Strip markdown title prefixes and duplicate body H1 from AI Update-created work items at write-time.
- 3bae80f: Run AI-created-story duplicate detection in a retried background Temporal workflow instead of inline
- cd34154: Fix background duplicate detection silently flagging nothing in the Temporal worker: verify candidate pairs with the COMPLEX model tier (reliable structured output in the worker) and fail loudly on a wholesale verifier outage so Temporal retries.
- 5345afc: Run semantic duplicate detection automatically on AI-created stories and add a "Possible duplicates" roadmap filter
- b6c1957: Fix long context names overflowing the Add Context list instead of truncating
- f5bc157: Highlight the selected diff review mode in the Inline / Side-by-side / Full preview toggle
- 2ab89de: Fix the diff review mode toggle so the selected mode is actually highlighted
- c56db17: Render diagrams, images, and rich content correctly in the document diff side-by-side / full-preview panes
- 4e766a4: Add Inline / Side-by-side / Full-preview review modes to the AI document-update diff in the Feature and Document editors
- eb34dda: Overhaul the roadmap duplicate-resolve dialog: two ticket columns each independently switch between Original and an AI-merged version, with the regenerate folded into the AI-merge button, a loading state, an info tooltip, a header "open in Fabric" link, and per-card merge actions.
- 55efd65: Duplicate-resolve dialog: move the "keep this" selector onto each ticket card so it sits with the card it controls (left card → left, right card → right), instead of a detached top toggle.
- d417c55: Harden the duplicate "true merge": Prompt Library resolution can never fail the combine — fall back to the in-code prompt bodies on any resolution error instead of surfacing a generic 500.
- 523d322: fix(weave-planners): add createRequire banner to tsup config so Pattern boots. The ESM bundle crash-looped on startup with `Dynamic require of "punycode" is not supported` — a transitive CJS dep (whatwg-url, via node-fetch → openai → @langchain/core) calls `require()` at runtime, which esbuild's ESM output can't satisfy. Injects `createRequire(import.meta.url)` as a banner (same fix already used in packages/cli and packages/mcp-server). This was the second boot crash in the Pattern container; the first (`iife` export) was fixed by the langchain 1.x bump in #1302.
- 064f5a9: fix(weave-planners): bump `@langchain/core` to `^1.1.24` and `@langchain/langgraph` to `^1.1.4` to match the rest of the agent fleet. The mismatched 0.3.x pin caused pnpm to install the modern 1.x runtime in the bundle while the dev/typecheck still resolved against 0.3 types, which manifested in production as `The requested module '@langchain/core/messages' does not provide an export named 'iife'` and crash-looped the Pattern Container App. Source code only uses stable primitives (`Annotation`, `END`, `START`, `StateGraph`, `BaseMessage`, `HumanMessage`) so no code changes are required.
- 6e62f80: Fizzy #1412 AC-2: operation-result chat messages now appear when you return to the tab — no reload needed
- e4392c6: Keep the sidebar alert/incident control in the current organization workspace instead of switching to Personal when clicked
- fee3073: Paginate the admin monitoring "Incident history" timeline and move it to the bottom of the dashboard
- 7d5f733: Move incident alerts off the notification bell into a complete monitoring-page history timeline
- b2c06d5: Operation-result chat card: outcome-tinted styling + terse success copy
- 64ec775: Roadmap items linked to a PM ticket now show a checkmark when the ticket reaches a configurable terminal status, with an optional per-project auto-close toggle and an AI-seeded, editable terminal-status list (ADO).
- 58f411a: PM terminal-status checkmark + auto-close now work for every connected PM tool (Fizzy/Jira/GitHub via MCP, GitLab via REST), not just Azure DevOps.
- deed701: Fixed a crash (infinite render loop) when opening the Edit Project flow for a project that has a connected backlog.
- c5730b3: Fixed the unified project creation wizard step counter intermittently showing only 2 steps ("Brief", "Review") instead of all 5 on the first page.
- 742002a: Revert the streaming duplicate-merge combine (broken on staging)
- 12de4b0: Surface roadmap duplicate-detection chips on the Kanban board, add backend test coverage, and de-duplicate the scan logic
- c7d1f30: Internationalize the roadmap duplicate-detection UI (en/de) and remove unused Kanban wiring
- a2cc93a: Rework the duplicate-merge dialog into two wide ticket columns with per-ticket Raw/AI toggle, diff, attachments, and focus
- c1a976e: Rework the duplicate-merge dialog into a read-only 3-column conflict-style view
- 82c0cce: Extend the roadmap duplicate "true merge" to also combine acceptance criteria
- cb36329: Redesign the duplicate-merge dialog to match the PM-sync conflict resolver (wide 3-column diff, dark-theme legible)
- a343a73: Speed up the duplicate "true merge" combine by generating the two fields in parallel
- 1cd6f40: Improve the roadmap duplicate-merge dialog: full content, diff preview, and persistent AI proposals
- e7e6a40: Speed up the duplicate "true merge" combine by trimming the per-side input cap
- 5125103: Add an AI-assisted "true merge" that combines the unique requirements of two duplicate features into one
- e545609: Add semantic duplicate detection to the roadmap with a Merge/Dismiss resolution path
- 563ddbc: Roadmap filters: every facet (Type, Priority, Stage, Sync, Source) is now the same compact dropdown, and selecting a value no longer shifts the row.
- 5d73f2a: Roadmap filters: surface the four flag filters as a single multiselect dropdown (consistent with the other facets) instead of a stack of toggles, move the recency windows (Any / 7d / 30d / 90d) beside the date ranges, keep recency labels on one line, and tighten responsiveness on both the filters panel and the duplicate-merge dialog.
- d8b22b3: Roadmap filters: add a "Needs more info" flag, move the recency (Recently approved / added / Date modified) controls under the Dates section, and align their label sizing with the other date filters.
- c3fd348: Fix Slack channels added via the "Add Context" dialog never being linked or monitored. The prior fix (#1312) shipped this wiring for the Teams selector but the matching change to `SlackChannelSelectorDialog` was lost before commit — only a cosmetic edit landed, so the changeset's Slack claim was untrue. As a result a Slack channel added through the dialog created a metadata-only `ProjectContext` row that sat in `PENDING` forever: no `ProjectLinkedSlackChannel` row, no monitor, no messages flowing into RAG (verified on staging — `slackChannelMonitor.linkChannel` was never called and `listLinkedChannels` returned `[]`).
- 6b03ada: Context items now show a source-specific icon everywhere they're listed. The Add Context dialog's Teams tab uses the real Microsoft Teams logo (was a generic chat bubble), and both the wizard's pending-context list and the in-project context list resolve each row's icon from its type/provider via a shared `getContextIcon` helper — so a Teams chat shows the Teams logo, Slack shows Slack, Notion shows Notion, Google Docs shows Drive, a PM-tool backlog shows its brand icon, and File/Link/Text keep their glyphs. Previously every integration row rendered the same speech-bubble icon, making it impossible to tell sources apart at a glance.
- d30df11: Wire metadata-only INTEGRATION contexts (Teams group chat, Teams channel, Slack channel) into their monitor workflows when added via the project wizard's Add Context dialog. PR #1298 marked these rows `COMPLETED` to clear the stuck "Pending" pill, but the row never reached `ProjectLinkedTeamsChat` / `ProjectLinkedTeamsChannel` / `ProjectLinkedSlackChannel`, so no monitor ever picked them up — chat messages were not flowing into the project's RAG store and AI generation never saw them. Now `createContextProcedure` calls the matching `linkXxxToProject` helper at create-time (and surfaces FAILED + extractionError on link errors), and `createIntegrationContexts` fires one `enable*Monitor` per family after the loop. Notion and Google Docs are unchanged (they already attach real fetched content and go through `contextEmbeddingWorkflow`). Confluence stays PENDING — no Confluence monitor exists yet; tracked as a separate follow-up.
- 2ca8f2e: Enable the Teams/Slack chat monitors from the Add Context dialog's chat/channel selectors. PR #1306 linked Teams chats server-side but only enabled the monitor in the project-activation path (`createIntegrationContexts`), which the dialog bypasses — it creates contexts through `TeamsChatSelectorDialog` / `SlackChannelSelectorDialog`. So a Teams chat added via the dialog was linked but never polled into RAG, and Slack was neither linked nor monitored. Both selectors now enable the matching monitor after adding rows: Teams group/channel monitors are enabled (rows already linked server-side); Slack channels are linked via `slackChannelMonitor.linkChannel` (resolves slackTeamId) then monitored. `slackChannelMonitor.linkChannel` also flips the matching PENDING Slack context row to COMPLETED so its status pill is truthful. Teams/Slack messages added through the dialog now flow into the project's RAG store.
- 5d2ede5: Fix two regressions in the unified project setup wizard's Add Context dialog:

## 1.3.1

### Patch Changes

- edd1e70: Stop the Teams/Slack channel-monitor feature-proposal flow from generating the unsupported Epic work-item type; it now proposes only Feature and Bug.
- f4602e1: Fix Slack Channel Monitor: "Save settings" no longer 500s on alternate clicks and "Monitor now" no longer 404s.
- 0630b65: PM integration now shows the GitLab name in project settings and the roadmap "Pull from GitLab" button (was generic/blank)
- f162e0d: GitLab REST conflict modal now shows live PM-side title + description (was empty)
- 44b56d2: Fix Atlassian Jira (Rovo MCP) being unusable as a project's Project Management Tool — picker now resolves the Jira project list
- 486121e: Revert "push ADO bugs as Bug work-item type" (#1287) — it broke ADO sync on real projects
- 91c8e86: Refine roadmap filters: count on its own line, no-jump facet pills, reliable cyclic sort, and Stage/Source as searchable multiselect dropdowns.
- 3eeed74: Move the roadmap filters inline on the canvas — a collapsible panel whose open/closed state is remembered per browser — and refine the feature-count display.
- fb483c3: Tier the roadmap filters — keep the primary facets (Type, Priority, Stage) always inline and move the rest under an inline "More filters" disclosure.

## 1.3.0

### Minor Changes

- 2a363b9: Switch the Google Docs project-context picker to the Google Picker SDK (adds the `drive.file` scope; needs new `GOOGLE_PICKER_*` env vars).
- 2a363b9: Add Google Docs as project context (flag: `feature-google-docs-context`) — pick docs from connected Drive and ingest them into the project's RAG store.

### Patch Changes

- ca759d7: Surface partial-batch failure counts in the AI Update chat result card so users see "30 of 32 added to roadmap — 2 failed" without leaving the sidebar.
- 7403b75: Add Azure DevOps as a code-repository option in project context settings and both setup wizards (shared PAT picker).
- ea87178: Fix middle-click on backlog story cards not opening a new tab on staging/production (switched `onAuxClick` → `onMouseDown`).
- 892f534: Fix "Open in new tab" on backlog story cards opening inside the installed PWA window instead of a regular browser tab.
- 1db88fd: Watchdog cron now also accepts Vercel-internal cron invocations (`vercel-cron` UA) so it fires even when `CRON_SECRET` is unset.
- 65fa7b3: Fix action dropdown menus being clipped at the viewport edge and under high browser zoom.
- 97d799c: `enqueuePmSync` now stamps rows FAILED with an actionable message when the user has no resolvable MCP config, and auto-recovers via the GitLab REST path.
- 8026dc5: Fix `appendConversationMessage` raw-SQL table name — `recordOperationResult` no longer returns 500 (Fizzy #1412 staging regression)
- d6dabe6: Fizzy `fetchPMItemsByIds` now resolves `account_slug` from the accounts/identity fallback when the project's stored context is missing it.
- 3957535: Loosen agentId status check in conversations.create to warn-only — fixes staging incident blocking all new conversations (Fizzy #1412 hotfix)
- 3118f75: Server-side agentId validation in `agents.conversations.create` (Fizzy #1412 round-2 follow-up)
- 3afe17b: Wire CopilotKit `confirm_changes` resolution in DocumentEditor into `agents.conversations.recordOperationResult` (Fizzy #1412 PR3 §7.4 Option A — phase 2)
- 0a21a55: Wire CopilotKit `confirm_changes` resolution in StoryWorkspace into `agents.conversations.recordOperationResult` (Fizzy #1412 PR3 §7.4 Option A follow-up)
- bc52d52: Migrate Tier 1 chat call sites + persisted rows to the canonical `fabric-workspace-assistant` agentId (keeps the `fabric-ai` seed alias).
- a187677: Add foundation for persistent operation-completion system messages in AI Assistant chat threads (Fizzy #1412 PR1, dark — no callers yet)
- a790e06: Wire Temporal-driven chat surfaces to PR1's operation-result foundation (Fizzy #1412 PR2)
- 6d67b5e: Wire BacklogChat into the operation-result foundation (Fizzy #1412 PR3)
- a0b63a9: Fix PM-sync: a Fizzy-pushed feature no longer shows "Unsynced" on the roadmap (and the next sync no longer creates a duplicate Fizzy card)
- 54a0f71: Fix PM-sync: surface create-orphan failures from approve/apply + retry flows + task sync (follow-up to roadmap-Unsynced fix)
- 2be98eb: Fix PM-sync: manual-push orphans no longer stay silently Unsynced (stamp FAILED before the throw in syncStoryToPM)
- 08b11b5: GitLab error UX hardening: Pull dialog + recheck capabilities + status cache + Test Sync audit log
- 8120fc7: Fix four GitLab integration UX bugs (stale "Connection Failed" banner, missing Disconnect confirm, no reauth callout, hydration mismatches).
- 0d4ba40: Fix the GitLab refresh path so a dead refresh token flips `needsReauth=true`, surfacing the "Reconnect required" callout proactively.
- 673eb85: Fix three GitLab PM container-picker defaulting bugs and harden the helper.
- 673eb85: Default the GitLab PM container picker to the codebase repository when the codebase is connected via GitLab.
- eedeb12: Auto-push on save now fires for GitLab REST projects (was a silent no-op)
- 7c9adb5: Add push-time conflict guard to GitLab REST sync (T2 parity — match ADO/Jira/Linear behavior)
- de84d68: Record PM-sync audit logs for GitLab REST sync (was invisible in Sync History while MCP tools like Fizzy logged normally)
- 9bcbadf: Hierarchy-sync now sends the required `fields: {summary, description}` payload for Atlassian Rovo `editJiraIssue` calls (closes #1270).
- b50506a: Relocate the active-incident signal to an inline dashboard-hero chip and a sidebar-footer marker, replacing the floating top-right chip.
- 136a0dc: Bring the project-invitation modal's inline signup/sign-in forms to full UX parity with the regular `SignupForm` / `LoginForm`.
- b4e52cf: Fix project-invitation modal copy where the project name, role, and email placeholders rendered as empty.
- 883ebae: PM-tool analyzer now detects Atlassian Rovo `editJiraIssue` (and any MCP update tool with a REQUIRED `fields` object) regardless of incidental top-level title/description param matches — closes #1266.
- a5c36ec: Fix stale Fizzy context lingering on a project after switching its PM tool to GitLab REST.
- a94431c: feat(pm-sync): ADO pull-side content drift detection + review (Chunk C)
- 542609f: Add the `projects.stories.sync.proposeAiMerge` oRPC procedure — a 2-way, description-only advisory AI merge for conflicting descriptions.
- 542609f: PM sync conflict v2: capture and propagate the PM ticket's last-changed author and date through the conflict-preview chain.
- 09fb23f: Normalize the PM side of the conflict-resolve diff to markdown so it shows real content changes instead of HTML-vs-markdown syntax noise
- 542609f: Update the PM-sync conflict-path E2E to the unified ConflictResolveDialog and add an AI-merge happy-path test.
- a6a4a40: Fix PM-sync AI-merge silently truncating long conflict descriptions; surface sync-failure detail in Sync History; fix dark-theme diff contrast.
- 29c3323: Record inbound PM-tool imports as "pull" rows in Sync History (previously unlogged for every tool — only the back-link push showed)
- 542609f: PM-sync: generalize `resolveConflict` over entity type (+ `overrideDescription`)
- 542609f: Rewire Review Center conflict rows to the unified conflict-resolve modal, making Epic and Feature conflicts resolvable.
- 542609f: PM sync: route StoryCard push-time conflicts through the unified resolve modal
- b6a84b3: Watchdog cron flips PM-sync rows stuck in PENDING > 10 minutes into FAILED so they surface in the Review Center for retry.
- c010711: `PmSyncCloudToggle` now surfaces the FAILED sync state on the cloud icon (red ring, "Failed" pill, and error tooltip).
- 542609f: Rewrite `ConflictResolveDialog` as the single canonical resolve modal with a diff-rich layout and an advisory AI-merge view.
- dfbca08: Channel-monitor approve now defaults to PM sync when the project has a PM tool configured.
- 6e3e4ab: Approved AI Update / channel-monitor proposals + agent-created stories now reliably push to the configured PM tool and stay in sync on later edits.
- 0d030af: Render Code Repository provider icons in brand colors (GitHub octocat, GitLab orange, Azure DevOps blue) instead of muted gray.
- a5958c0: Redesign the Roadmap filters into a single consolidated, responsive panel with grouped facets and an accurate result count.
- 7c7efc6: Extend title-collision dedup guard to fabric_create_story agent tool; relocate guard to @repo/database
- 2bd333c: Block duplicate-by-title CREATE in Teams/Slack proposal approval
- b53a74e: Preserve failed AI Update proposals in the queue with retry, dismiss, and a roadmap banner so silent sync failures stop losing tickets.
- 6423c63: Unify the "New Project" and "Existing Project" onboarding into a single project setup wizard.
- c66f556: Refine the unified setup wizard's Brief step: provider-card Code Repository layout, plain (non-accordion) sections, Website URLs removed.
- 9db69e5: Watchdog cron now retries stuck PM-sync workflows for up to 60 min before stamping FAILED, recovering when the Temporal worker returns.
- 8fd585a: Fix Weave background agents running indefinitely after task completion.
- 0091da1: Label the new weave audit-log actions so the UI stops saying "Unknown action".
- d62a349: Fix misleading `outcome: "failure"` on the no-op cleanup audit row.
- a03eea2: Wrap weave teardown activities in `workflow.patched()` to preserve replay determinism

## 1.2.0

### Minor Changes

- 207022b: Hybrid Atlassian Cloud OAuth 3LO for real Jira screenshot attachments.

### Patch Changes

- 446b4e8: Atlassian Cloud attachments — wire OAuth env vars into deploys + add onboarding banner.
- afdc690: Route Jira attachment uploads to each issue's own Atlassian site.
- 6ef91d4: Right-click / middle-click any backlog work item to open it in a new tab (keyboard-accessible via Shift+F10, telemetry-tagged).
- 79d86bf: Eliminate duplicate brand-name accessible labels by switching branded inline SVG icons to decorative (`aria-hidden`).
- 3b2e13e: Truncate each CHANGELOG entry to its headline via a custom changesets formatter.
- 1b7f8a8: Auto-attach Slack and Teams chat-thread images to AI-generated backlog items at approval time, with a warning fallback when downloads fail.
- 48c84b5: Bring the unified "Add Context" section to the Existing Project creation wizard (File / Link / URL / Text / Teams / Slack / Notion with live Ready/Indexed status).
- 5945729: AI-generated Excalidraw diagrams auto-land in the editor — agent emits inline `<excalidraw-embed>` from `create_view`, or chat surfaces show an "Insert into Doc" button.
- e7da027: Cap backlog-snapshot descriptions so the Temporal activity input stays under 2 MiB.
- 0076a34: Demote forced `tool_choice` to "auto" in direct chat when Anthropic thinking is enabled.
- 351528a: Detect Claude by model name (not LangChain wrapper class) when demoting `tool_choice` force.
- c5c04fb: Drop the eager `tool_choice` force entirely — universal across all reasoning-model providers.
- f6d5dcc: Stamp org id on Excalidraw embeds so saved diagrams load on reload instead of 404ing.
- c36e84b: Resolve the active org in the Excalidraw embed so saved diagrams render (no more 404 on reload).
- 8e82584: Preserve `<excalidraw-embed>` through the Markdown save path so diagrams no longer vanish on save.
- 321bf9f: Show the diagram "Insert into…" button only in the AI Assistant (hidden in Nexus / Loom).
- 61cef03: Unblock the staging Excalidraw agent (thinking + `tool_choice`) and return a structured 403 on `createFromChat`.
- 76d16c1: GitLab audit batch 1 — five focused fixes (test infra, indexing, REST sync, MCP refresh, error classification).
- 4e76341: GitLab audit batch 2 — OAuth / token-refresh hardening (3 coordinated fixes including advisory-lock follow-up).
- fdbab07: Surface silent decrypt failures in GitLab and workflow integration paths so missing credentials no longer fail quietly.
- c120429: GitLab PM picker — surface a connect-for-org CTA when GitLab is in personal scope.
- e085399: Surface GitLab in the project-creation picker via REST whenever a GitLab `WorkflowIntegration` exists, even if the `MCPServer` catalog row is missing.
- 63fef13: Honor the `key:gitlab-official` sentinel in single-story push, the "Test Sync" settings button, and background temporal pulls.
- 20332da: Honor the `key:gitlab-official` sentinel in PM auto-wire on OAuth callback, the capabilities resolver, and PM target resolution.
- fd7e9dd: GitLab PM tool UI parity sweep — shared REST client, health-check, and feature alignment with other PM tools (closes Fizzy #1414).
- 8f0c3f6: Upload Jira screenshots on the worker / auto-push path and surface attachment failures to the user.
- ffda200: Render Jira and Fizzy screenshots inline on auto-pushed tickets.
- 0b20ca6: Atlassian OAuth auto-chain — one click connects both Rovo and Cloud.
- 5608c64: Reset MCPConfig `status` to `HEALTHY` when storing fresh OAuth tokens (no more lingering `UNAVAILABLE`).
- 685d275: Serialize OAuth refresh and retry on `invalid_grant` to handle single-use refresh tokens safely.
- 2e60b97: Convert the full body to HTML on ADO push (not just tables) — follow-up to #1155 / #1158.
- 239f970: Recognise Atlassian Rovo MCP's camelCase tool names + fields-object update shape.
- 70b4f46: Use Fizzy's `attachable_sgid` for ActionText attachments and remove the probe — fixes broken-icon glyphs on Fizzy cards.
- 59c1063: Inline Fizzy images as base64 + replace in-cell `<br>` with `/` on Jira (follow-up to #1155 / #1158 / #1160 / #1162).
- 9a5b9a2: Switch Fizzy push to native Rails ActionText `direct_uploads` for images instead of base64.
- b59e108: Keep the Sync History tab and Review Center current without a page reload.
- 9c237a3: Upload images as Jira attachments and rewrite description URLs to the attachment links.
- c5b9cba: Inline images as base64 data URLs on Jira push (revert silent attachment upload).
- 3c70674: Unify description format across PM tools (Markdown for GitHub / GitLab / Linear / ClickUp / Trello).
- 6e51fb3: Durable PmSyncLog audit log + unified Review Center (Chunk A) — `PmSyncLog` schema with XOR tenant scoping, `recordPmSyncLog` write helper wired into the five PM-sync outcome boundaries, oRPC procedures + paginated `listPmSyncLog`, opt-in TTL retention cleanup, read-only Sync History tab in Project Settings, inbox-style Review Center on the roadmap toolbar, RTL hardening, and two Review Center defect fixes (per-row PM-tool label + in-page Settings deep link).
- da80e3b: PM-sync — actionable error + one-click board re-select for stale-site failures.
- 3fbc1a7: Detect product-infix PM-tool names (Atlassian Rovo) in capability detection.
- 519a9a4: Roadmap filters — audit pass for Fizzy #1411 (accuracy fixes + surface logically empty combinations).
- 475d544: Per-project sequential ticket IDs via an atomic counter + `(projectId, identifier)` unique constraint — eliminates the duplicate-row race; legacy prefixed IDs still searchable; PM-sync titles no longer carry the Fabric prefix on new pushes.
- c7096f2: Teams attachments — retry on 404 + root-URL fallback for reply hostedContent downloads.
- 7fa7630: Teams attachments — use verbatim hostedContent `srcUrl` for reply attachments.
- 290cd76: Unified context uploader in project creation — `ContextUploaderDialog` mounts inside `BasicInfoStep` with File / Link / Text / Teams / Slack / Notion against the auto-saved DRAFT, plus a `draftProjectCleanupWorkflow` that cancels in-flight crawls on abandonment.
- 6380e87: Polish for the unified context uploader wizard — fix status polling staleness on TEXT / INTEGRATION and a11y contrast on the success token.

## 1.1.0

### Minor Changes

- 7998d05: Track the deployable app via a private `fabric-app` package and adopt changesets-driven releases with auto-tagged prod deploys.
- 8b797e3: Fix CopilotKit 1.52 reload hydration race so the AI chat sidebar repaints prior messages + image previews; adds a "View version" link next to accepted diffs in the History drawer.
- 30a2435: Fix AI Assistant sidebar hydration flake on reload by rendering historical messages outside CopilotKit's lifecycle via a new `<CustomMessages>` component reading from a hydrated-blob provider.
- cccd1eb: Close two AI Assistant gaps from PR #1133 staging — persistence walker now merges tool-call sibling messages so diff outcome chips render in prod, and cross-tab sync gains a localStorage fallback for privacy-mode / Safari ITP contexts.
- 9ee6836: AI Assistant session UX: visibility lock chip updates immediately on first message, rejected diffs get a "View version" link, and outcome chips now appear in the live chat (not just the History drawer).
- a174010: Per-message timestamps on every chat bubble (live + drawer) and a Fork-from-here action that copies messages [0..N] into a new conversation with attachments / toolCalls preserved.

### Patch Changes

- f465454: Fix AI Update creating duplicate work-item rows — server-side pre-create dedup guard on normalized titles blocks LLM CREATE/UPDATE confusion, legacy `[BUG]`-prefix collisions, and intra-batch repeats.
- 57932b7: Add inline Feature/Bug type selector to the AI Update approval flow so PMs can correct kind before approval (bypasses F-171 classifier and flows to PM-tool sync); selection persists per-row in localStorage.
- 57932b7: Retire `type: "story"` from AI Update proposals (DSU 2026-05-23 decision) — analyzer prompt now forbids Story, removing a primary source of duplicate ticket pairs.
- dfbd469: Make `AttachmentsField` dropzone keyboard-accessible (WCAG 2.1 AA) with `role="button"`, focus ring, and Enter/Space file-picker activation.
- dfbd469: Localise `AttachmentsField` via `next-intl` — move five hard-coded English strings into the `projects.stories.create.attachments` namespace (en/de).
- c343c5e: Recognize `confirm_changes` (the LangGraph agent's real diff tool name) and walk AGUI-format messages so Accepted/Rejected chips + View version button light up after a real accept on staging.
- 802b2d8: Expand `isVisionUnsupportedError` regex to catch OpenAI/Azure "unsupported image" phrasing — vision-incompatible tenants now fail fast with the actionable user message instead of retrying through MAX_RETRIES.
- 541e074: Fix file-picker no-op on attach buttons app-wide: replace `className="hidden"` with `sr-only` on every programmatically-clicked `<input type="file">` (Chromium 124+ blocks pickers on `display:none` inputs).
- 3430bd5: Fix Fizzy push so Tiptap-authored tables render as real tables instead of escaped `<table>` text by pre-extracting and converting each table to Lexxy's shape before the HTML-escape pass.
- fdf2ab0: Follow-ups from PR #1154 — Fork no longer crashes the editor (dropped the mid-render `setCopilotMessages` push), and the Pending diff chip now renders on reload by exposing the previously-filtered no-outcome state.
- 0ed3c00: Fix GitLab PM sync for projects migrated from MCP to REST — the REST fallback now engages on stale `projectManagementMcpConfigId` so Roadmap Pull and Test Sync work for users with an OAuth connection.
- 0d475f1: Fix the AI Assistant sidebar staying empty on ~1 in 5 reloads — clear the hydrator's dedupe set when `useAgent` swaps from provisional to real agent so writes re-fire.
- 9eb0455: Re-arm AI Assistant hydration when CopilotKit's `connectAgent` wipes our writes — the hydrator watches the live-message high-water mark and re-fires on a detected post-write wipe.
- 3c3e9fd: Fix Accepted/Rejected chip + View version never rendering on real diffs — switch the matcher from `useCopilotChat().visibleMessages` (empty on staging) to the internal store the persistence walker uses.
- ee5cd49: DB-driven content versioning for the MCP registry Redis cache — a Postgres trigger bumps a counter embedded in the cache key on every `mcp_server` write, so any write (Prisma, migration, hand-edit) naturally invalidates the cache.
- 31fc365: Preserve `<br>` and `<ul>` / `<li>` inside table cells on GFM cell conversion (Jira/GitHub/GitLab/Linear), and route ADO push through a clean-HTML transform so `System.Description` renders tables as real tables instead of literal markdown.
- 7be0473: Preserve tables and images when pushing Fabric features to PM tools — Tiptap tables convert to GFM (or Lexxy for Fizzy) and `story-media/...` images resolve to 7-day signed S3 URLs across all three push paths. Closes 2026-05-21 known limitation.
- 8ccf646: Fix PRIVATE conversation visibility not honored on first send — chip toggle now propagates to parent state via a new `onVisibilityChange` callback, so the lazy-create call receives the user's choice.
- f2a3a74: Finish the toolCalls-persistence fix from #1138 — server merges toolCalls on duplicate id when the existing row has none, and the client walker dispatches a patch persist call when the tool-call sibling arrives a tick after its parent text.
- 9ee6836: Fix the AI Assistant sidebar staying empty after every reload — replace HTTP self-fetch in SSR loaders (`ECONNREFUSED` on Vercel + Node prod) with an in-process DB call across all four loaders.
- dfbd469: Attach images in the Create Story Dialog (Kanban + Roadmap variants) — `<AttachmentsField>` uploads files after story creation and appends keys as a `## Attachments` markdown block. Closes Fizzy #1389 Phase 1.
- 96f06a7: AI Feature Assistant reads story-attached images multimodally — resolves `story-media/...` keys server-side, base64-encodes, and appends to `ragContexts` so they attach as `image_url` parts on the last `HumanMessage`. Closes Fizzy #1389 Phase 2.
- 120d043: Fix story-media images not rendering when inserted as bare markdown `![alt](story-media/...)` — extract regex into `extractStoryS3KeyFromImgSrc` that recognises bare, root-relative, and full signed-URL shapes.
- d2be4e8: Fix AI Feature Assistant multimodal pipeline silently broken since Phase 2 — move resolver from `@repo/api` (whose deep imports broke the agent's tsup build) into a new oRPC procedure `projects.stories.resolveMediaForAgent` called from `StoryWorkspace`.
- defac32: Tighten `isVisionUnsupportedError` regex to avoid false positives on generic upload-validation strings — anchor "image is valid" patterns on "make sure your image is" so own oRPC validation messages don't short-circuit the retry loop.

## 1.0.0

### Major Changes

- First release.
