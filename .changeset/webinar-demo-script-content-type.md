---
"fabric-app": patch
---

Publishing now supports Webinar / Demo Script as a sixth content type, from topic suggestion through draft generation and download

Fizzy #1988, Publishing Suite Phase 2D slice 2D-1. Adds WEBINAR_SCRIPT end to
end: topic suggestion and planning-analysis prompts now name it as a distinct
type (with its own sync migrations for already-deployed prompts), a dedicated
generation activity and prompt compose a running-order-shaped draft rather
than prose, the web review panel is wired into generation, and the confirmed
download carries the reader's own edited draft.

Extracting the asset-confirmation clamp into a shared `@repo/utils` module
(`publishing-asset-clamp.ts`) so the new type could reuse it changed how the
already-shipped Case Study type de-duplicates demoted assets. Before, the
dedupe `Set` was built straight from the existing needs-confirmation list —
exact string equality. After, both sides are normalized (case-folded,
whitespace-collapsed) before comparing. A demoted asset that matched an
existing entry only by case or surrounding whitespace used to be appended a
second time, so the reader saw the same asset listed twice under two
spellings; now it is recognised as the same asset and appended once.
Selection had always matched normalized — only the dedupe step was exact, and
that mismatch is what made the double listing possible. `clamped.assets` is
still recorded pre-dedupe at the Case Study call site, unchanged, and Case
Study still does not persist `assetKinds` — only the new content type does.

Teaching the generation tabs the new type's phrasings also changes what the
five already-shipped tabs warn about. An open content-type question naming a
webinar or demo script had no owning tab before, so it fell through the synonym
table to the fail-safe branch and cautioned every tab at once. It is now
claimed by the Webinar / Demo Script tab, and the caution appears only there.
A reader who had such a question open will see the warning disappear from Blog
Post, Short Post, LinkedIn Post, Case Study and Stakeholder Email — nothing
about those five changed, and the warning was never about them. A phrasing no
synonym lists still cautions everything, so the fail-safe itself is unchanged.
