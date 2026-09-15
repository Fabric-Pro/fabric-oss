---
title: "A destination rename moves the href and strands the label, because only the href is tested"
date: 2026-09-15
category: conventions
module: web app — Connections destination, Get started registry
problem_type: convention
component: frontend
severity: medium
applies_when:
  - "Moving a page to a new route or section and renaming what it is called"
  - "Renaming anything the Get started registry, a breadcrumb map, or a 'Back to X' button refers to"
  - "Auditing a surface where some occurrences of a word name the container and others name a thing inside it"
  - "Touching a label that sits next to an identifier used as an anchor, a test fixture, or a persisted key"
tags: [naming, migration, get-started, registry, drift-test, breadcrumbs, vocabulary, concepts]
related_components: [documentation]
---

# A destination rename moves the href and strands the label, because only the href is tested

## Context

The integrations catalogue moved from `/settings/integrations` to a top-level
`/connections` destination. The sidebar item, the page title, the heading and the
breadcrumb all became "Connections", and `/settings/integrations` became a redirect.

Three Get started registry entries kept `label: "Integrations"`. Their `href` values
were changed to `/connections` **in the same object literals**, in the same commit —
the author was inside those braces and edited the line below the label. The same hunk
also relabelled a sibling card and rewrote its description to say "They live under
Connections". So this was not a decision to keep the old word; the labels were simply
not what the author was looking at.

Nobody noticed for two releases. A ticket was eventually filed reporting the drawer as
inconsistent with the page — and by then the ticket's own premise was stale too, since
it asked for a page rename that had already shipped.

## Guidance

**1. Route correctness and label correctness are two different verification problems,
and only one of them fails loudly.**

A wrong `href` announces itself: a broken link, a 404, a red navigation test. A stale
label announces nothing. It renders perfectly, in the wrong words, indefinitely.

So a destination rename needs a second, deliberate sweep that the route change does not
give you for free: grep the **old word** across the whole surface, not just the routes.
In this codebase that surface was wider than it looked — a nav card, a settings-list
card, a page-tour entry, three `SettingsHero` `label` props, three "Back to X" buttons,
a redirect route's metadata title, and the page's own loading, error, empty and
placeholder strings. Nothing enumerates "every place that names this destination",
which is exactly why a subset survives.

**2. Sort every occurrence into container, sub-kind, or structure before renaming any of
them.**

This is the part a blind find-and-replace gets wrong, and it cuts both ways.

- **Container** — it names the destination. Rename it.
- **Sub-kind** — it names one of the things inside the destination. Leave it. Here,
  Connections contains *Integrations* and *MCP servers*, so the segmented control's
  "Integrations" tab, the "Action integrations" group and the "Browse integrations" item
  are all correct as they stand. Renaming them would collapse the very distinction the
  page exists to draw.
- **Structure** — it names a URL slug or a tree the move did not actually change. Leave
  it. The settings breadcrumb map still reads "Integrations" because provider and action
  detail pages genuinely still live under `/settings/integrations`. Renaming that key
  would have made every detail page read "Settings → Connections", asserting the
  information architecture the move had just dismantled.

A review caught that last one only after it had been written into a plan as destination
copy. The tell is the source comment two lines above the map, which already said detail
pages stay under the slug.

**3. Freeze the identifiers separately, and say why in a test.**

Labels are safe to change; the identifiers sitting beside them often are not. In this
registry the frozen set was: the entry `id`s, the `anchor` string-matched against the
live sidebar by the drift guard, the `getStartedPageId` bound to a bijection test, the
in-page `data-onboarding-target` attributes — and the page-tour `tab` key, which is
**persisted per user** as a `seenPages` marker. Renaming that one orphans every existing
user's record of which tours they have already seen.

Pin that separation in a test next to the change, not in the drift guard itself, so the
guard stays byte-identical and a future "tidy-up" rename fails with a message that
explains itself.

**4. Scope a "the old word is gone" assertion to the destination, or it will misfire.**

The obvious guard — no registry item is labelled with the old word — is wrong in exactly
the case rule 2 describes. A future card that legitimately names the sub-kind would trip
it, and the failure would read like a container-rename violation. Scope the assertion to
items that actually lead to the renamed destination:

```ts
const stale = allItems.filter(
    (item) =>
        item.label === "Integrations" &&
        item.href?.({ basePath: BASE })?.startsWith(`${BASE}/connections`),
);
expect(stale).toEqual([]);
```

**5. Give the new container a glossary entry in the same change.**

`CONCEPTS.md` had no entry for Connections. A drawer that lists every area is itself a
vocabulary surface, so a missing definition is not a documentation gap that sits
harmlessly beside the code — it is the reason the wrong label looked fine to everyone
who read it. Define the container and name the near-synonym as a trap, so the next
person renaming something here can tell rule 2's three categories apart without
re-deriving them.

## Verification

- Grep the old word across the whole app, then classify every hit as container, sub-kind
  or structure before changing any of them. Expect to leave some deliberately.
- Run the Get started drift guard and confirm it stays byte-identical; new assertions go
  in a sibling file.
- Confirm each frozen identifier's occurrence count is unchanged.
- For a redundant entry that is deleted rather than renamed, grep the id repo-wide,
  including tests, docs and e2e specs, before removing it.

## Related

- `docs/solutions/workflow-issues/verify-inherited-scope-against-current-reality.md` —
  the ticket's own premise was stale; the page rename it asked for had already shipped.
  Check a stated scope against the current tree before acting on it.
- `docs/solutions/design-patterns/moving-a-floating-element-into-normal-flow.md` —
  spacing belongs on the wrapper, which is what the new intro paragraph relies on.
