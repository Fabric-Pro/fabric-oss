---
"fabric-app": patch
---

Add LinkedIn as a Publishing Suite content type, with a prompt written for the feed's "see more" fold rather than a character limit.

LinkedIn is its own `PublishingTopicPostType` value rather than a re-labelled
`TWEET`, and the argument is a platform fact rather than a preference: a
LinkedIn feed collapses a post behind "see more" after roughly the first line or
two and imposes no hard ceiling on what follows, while X imposes a hard ceiling
and folds nothing. Those are opposite constraints on the same sentence — a tweet
reposted to LinkedIn buries its hook below the fold — so the two need different
opening structures and therefore different prompts. That constraint is the whole
of what distinguishes the new prompt body; grounding, approvals and the
three-option contract are the short post's, and the locked clauses are literally
the same function rather than a copy of it.

Ships end to end, following the Short Post / Tweet slice as its template:

- `LINKEDIN_POST` on the Prisma enum, via a standalone `ALTER TYPE ... ADD VALUE`
  migration (`20260909130000_add_linkedin_post_type`). Nothing references the new
  value in the same transaction, so it needs no follow-up migration.
- A new prompt-library key `publishing_topic_linkedin_post` with its default
  body in `@repo/utils`, seeded and registered in the prompt action catalog so an
  organization can edit it. The fold instruction is deliberately in the EDITABLE
  body — it is craft advice — where the approval rules stay code-side.
- `publishing-linkedin-post` Temporal activities plus
  `generatePublishingLinkedInPostWorkflow`, mirroring the short post's pair
  including the deterministic reject-duplicates workflow id and the
  degradation-boundary contract. Its own `job-keys` entry, so LinkedIn spend does
  not average into the tweet line item.
- `generateLinkedInPost` / `selectLinkedInPostOption` procedures, with
  `refineFromWorkingDraft` and `AiOutcomeEvent` emission under a new
  `publishing-linkedin-post` subject type.
- A `LinkedInPostPanel` that leads with the fold rather than a character count,
  and states both directions of it — where a long draft folds, and that a short
  one does not. The fold arithmetic moved to a shared `feed-fold` module now that
  it has two consumers.

Two hardcoded post-type lists were replaced by the shared
`PUBLISHING_TOPIC_POST_TYPES` tuple while adding the value. One of them was a
latent bug: `updatePublishingTopicPostTypes` capped its array at a literal
`.max(4)`, so a fifth type would have made "select every type" a validation
error on a dialog whose whole purpose is choosing several at once. The other,
`listTopicDrafts`' output schema, would have silently stripped LinkedIn rows on
their way to the page.

Known gap, deliberate for now: **the suggestion engine cannot recommend LinkedIn
yet.** Adding the value widened the LLM output whitelist, and the planning
analysis prompt was taught that LinkedIn is a distinct format from a tweet — but
the topic-suggestion prompt was not touched, so a topic gets a LinkedIn tab only
when a person picks it in "Edit post types". The planning prompt is also
INSERT-ONLY, so its new wording reaches an already-seeded environment only via an
explicit UPDATE migration, which this change does not ship.
