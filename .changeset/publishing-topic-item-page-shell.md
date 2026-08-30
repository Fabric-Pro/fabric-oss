---
"fabric-app": patch
---

Publishing Suite topics now open on their own page, with Summary & Questions, Planning & Analysis and Decision Log tabs.

Fizzy #1851, Phase 2A slice 1 of 3 — the page shell. Generation and the AI
planning worksheet follow in 2A-2 and 2A-3.

What ships:

- Route `projects/{id}/publishing/{topicId}` in both the personal and the
  organization route groups, gated on the same two flags as the list page
  (`FABRIC_FEATURE_PUBLISHING_SUITE` plus the `NEXT_PUBLIC_` UI-rollout flag)
  and in the same order — before any session, org or project access. A detail
  route that gated more loosely than its list would be a way to reach
  Publishing Suite data by guessing a URL while the UI is deliberately hidden.
- `publishingSuite.getTopic`, gated on `PUBLISHING_TOPIC_READ`. It delegates to
  `listPublishingTopics` through a new `topicId` filter rather than running a
  second query, so the detail page inherits that function's six degrade
  contracts (contributor handles, viewer tags, author recommendations,
  why-suggested, read markers, partition) by construction instead of by copy.
  A topic id from another project returns the same NOT_FOUND a missing topic
  gets, so the endpoint cannot be used to probe for topics in projects the
  caller cannot see.
- Summary & Questions is the default tab and renders the topic's existing
  AI-written summary, so the slice is useful on its own rather than three empty
  panels. Planning & Analysis and Decision Log render empty states.
- Four generation tabs (Tweet, Blog Post, Case Study, Stakeholder Email) render
  disabled and marked Coming Soon, driven off the existing
  `PublishingTopicPostType` enum so later phases activate a tab by shipping
  their feature rather than by editing a second hand-maintained list.

Two behaviour changes to the existing Inbox row, both deliberate:

- The topic title is now a real anchor, so middle-click, Ctrl+click and "open
  in new tab" work. It could not stay inside the disclosure button — a link
  nested in a button is invalid markup and destroys the button's accessible
  name — so the disclosure moved to its own chevron, keeping the same test id
  and the same `"{title}, read|unread"` label that is the row's only
  non-colour unread signal.
- Opening the page marks the topic read. Phase 1D already treats expanding a
  row as opening it; the full page is the strongest form of opening there is,
  so it must not be the one that does not count. A failed read-marker write
  surfaces the same toast the Inbox row shows for that write, and releases its
  once-per-mount guard so a later refetch can retry rather than leaving the
  unread dot permanently stale.

The design was gated through a Codex adversarial review, which returned nine
findings against the first draft — all nine confirmed by inspection, none
refuted. Three landed on this slice and are fixed here; the rest reshaped the
later slices (the questions UI and its producer were swapped so each slice
works alone, and the decision row's tenant tuple was corrected — publishing
topics are XOR-normalised with a DB CHECK, so a child row cannot carry a
required userId the way the Feature decision log does).
