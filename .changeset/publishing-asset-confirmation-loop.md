---
"fabric-app": patch
---

A confirmed asset now leaves a draft's needs-confirmation list, and a draft can raise that confirmation question itself.

Fizzy #1988 follow-up. Found while QA-ing Phase 2D on staging: a generated draft
ends with the assets it references but cannot vouch for and tells the reader to
confirm each one before publishing — with nowhere to record that they had. The
list is written by the generation run, nothing carried it back, so the same
items reappeared on every regeneration.

Three content types carry an asset list (Case Study, Webinar / Demo Script,
Newsletter Blurb) and all three now close the loop:

- **The draft raises the question.** Each run mints an `ASSET_APPROVAL` question
  for whatever it could not confirm, keyed by the same `deriveQuestionId` the
  planning analysis uses — so an asset is ONE question whichever draft names it,
  and it lands in Summary & Questions where a reader already looks.
- **Mint-if-absent and reactivate, never a sweep.** `reconcileTopicQuestions`
  soft-closes what its caller stopped raising, which is right for one producer
  per kind. Three draft producers sharing that kind would have a Case Study run
  soft-close the asset a Webinar draft was waiting on, and the next Webinar run
  reactivate it — flapping on every generation. A new `raiseDraftQuestions`
  keeps the identity match and the never-reopen-a-settled-row rule and drops the
  sweep; a nullable `raisedByPostType` column keeps the analysis's own sweep off
  rows it does not own, and the analysis adopts a row once it raises it too.
- **The answer now moves something.** The clamp only ever demoted, so answering
  changed nothing mechanical: the list is the model's and the model was asked
  again. `promoteConfirmedAssets` runs before the clamp and lifts a cleared
  asset out. Matched on exact normalized equality, NOT the clamp's containment —
  over-matching demotes safely, but it would promote an asset nobody cleared.
- **The questions that already exist count too.** The planning analysis has
  always minted its own `ASSET_APPROVAL` questions with a two-option approval,
  and those sit answered on live topics. Its "Approved — the draft may use X."
  reads as an any-audience confirmation, so an asset somebody approved before
  any of this existed stops being listed as unconfirmed.
- **A refusal restricts too.** The clamp saw unresolved threads only, so a
  thread settled "no, do not use that screenshot" left its input exactly as an
  approval did and a model claim about the asset survived — the one answer that
  changed nothing at all. A refused asset is now fed into the clamp.
- **Scope is enforced, not just recorded.** The three offered answers carry an
  audience, and a scope that does not cover the content type keeps the asset
  unconfirmed. Previously a settled thread stopped restricting whatever the
  answer said, so "approved for internal use only" unlocked it everywhere.

Also in this change, from the same review: the webinar prompt's provenance
comment claimed no PO prompt document existed (it is attached to a card comment,
and `has_attachments` describes the body only); the workflow registration guard
traded two hand-bumped numeric floors for a set derived from
`PublishingTopicPostType`, after a deletion simulation showed the floors staying
green with a content type unregistered; `TopicDraftState.versions` is required,
which is the optionality that let two panels ship with no version list and still
type-check; and the amber tab caution now says which of its three independent
causes fired, so a type the analysis merely set aside no longer sends its reader
to a questions tab with nothing in it.
