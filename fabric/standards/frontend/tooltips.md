# Tooltips

Contextual hover/focus tooltips for action buttons, icon-only controls, and toggles.

- **Audience**: frontend engineers adding or changing interactive controls
- **Owner**: web app team

---

## When to apply

Add a tooltip to a control when **any** of the following is true:

1. The control is **icon-only** (no visible text label).
2. The visible label is **ambiguous** — single word, trade jargon, or unclear side effect (e.g., "AI Update", "Start Fresh", "Pull from PM tool").
3. The action is **destructive or irreversible** — delete, clear, revoke, disconnect, reset, archive, or any mutation with no confirm dialog.

Skip when the label is plain-English, multi-word, self-evident, AND non-destructive (e.g., `Save Changes`, `Cancel`, `Close`). Document the skip in the audit if one exists.

## Primitives

Two components live at `apps/web/modules/ui/components/`:

- **`<Tooltip>`** — informational. Composed of `TooltipProvider` + `TooltipTrigger` + `TooltipContent` from Radix. Default delay is **500ms**, globally configured in `TooltipProvider`.
- **`<DestructiveTooltip>`** (`destructive-tooltip.tsx`) — destructive variant. Renders with `--destructive` / `--destructive-foreground` tokens, an `AlertTriangleIcon`, and a `label` + `warning` pair of strings. On keyboard focus, the content carries `role="alert"` so screen readers announce it; on pointer hover it stays `role="tooltip"`.

### What `TooltipContent` already gives you

These are **defaults, not ceilings** — `cn()` runs tailwind-merge, so a call site that passes a conflicting utility still wins. Do not restate a default just to be explicit; a redundant utility reads as a deliberate deviation to the next person.

| Default | Value | Why |
|---|---|---|
| Max width | `max-w-[min(90vw,20rem)]` | Without a cap, `w-fit` lets long copy span the viewport. Override only when the content genuinely needs a different measure (e.g. a full document title). |
| Wrapping | `text-pretty break-words` | Fills line 1 before wrapping. `text-balance` left long copy wrapping short of the cap. |
| Size | `text-xs` | |
| Colour safety | `INVERSE_TOKEN_OVERRIDES` | See below. |

**You do not need `surface="popover"` for legibility.** The `inverse` surface paints `--foreground` as its background, which used to render any nested `text-muted-foreground` / `text-foreground` / `text-primary` child unreadable — 12 of 14 token/theme pairs failed WCAG AA, and `text-foreground` was literally invisible at 1.00:1. `TooltipContent` now re-points Tailwind's `--color-*` namespace on the content element so those utilities resolve against the tooltip's own palette. Worst case is now 7.08:1. Pick `surface="popover"` when the content should *look* like a small card (legend rows, multi-paragraph descriptions), not to make it readable.

**When adding a token to the remap, target `--color-<token>`, never the raw `--<token>`.** Tailwind v4 resolves `--color-muted-foreground: var(--muted-foreground)` once at `:root`, so overriding the raw variable deeper in the tree is a silent no-op. `tooltip-surface.test.tsx` pins this.

## Copy storage — always via i18n

All tooltip copy lives in `packages/i18n/translations/en.json` under the `tooltips` namespace. Never inline English strings in components. German (`de.json`) is not translated for this feature — English remains the source locale.

### Namespace structure

```
tooltips.common          -- shared actions reused across surfaces (delete, disconnect, clearSearch)
tooltips.pipeline        -- feature pipeline page
tooltips.documentEditor  -- document editor
tooltips.contextSources  -- context/sources section
tooltips.projectSettings -- project settings tabs
tooltips.projectHeader   -- project detail header
tooltips.prompts         -- prompts surface
tooltips.stories         -- roadmap / kanban / story-related views
```

Add a new surface bucket when introducing a distinctly new area of the app. Reuse `tooltips.common.*` only when the exact copy applies across multiple surfaces.

### Entry shape

- **Informational** — a plain string.
  ```json
  "pushToRoadmap": "Parse the Features document and create one Roadmap card per feature."
  ```
- **Destructive** — an object with `label` and `warning`. The `warning` value must start with the literal prefix `"Warning: "` (enforced by the i18n sanity test).
  ```json
  "delete": {
    "label": "Delete this item.",
    "warning": "Warning: this cannot be undone."
  }
  ```

## ✅ DO

### Informational tooltip

```tsx
"use client";

import { useTranslations } from "next-intl";
import { Tooltip, TooltipTrigger, TooltipContent } from "@ui/components/tooltip";
import { Button } from "@ui/components/button";

export function PushButton({ onClick }: { onClick: () => void }) {
  const t = useTranslations("tooltips.pipeline");

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button onClick={onClick}>Push to Roadmap</Button>
      </TooltipTrigger>
      <TooltipContent>{t("pushToRoadmap")}</TooltipContent>
    </Tooltip>
  );
}
```

### Destructive tooltip

```tsx
"use client";

import { useTranslations } from "next-intl";
import { DestructiveTooltip } from "@ui/components/destructive-tooltip";
import { Button } from "@ui/components/button";

export function DeleteButton({ onDelete }: { onDelete: () => void }) {
  const t = useTranslations("tooltips.projectSettings");

  return (
    <DestructiveTooltip copy={t.raw("deleteProject") as { label: string; warning: string }}>
      <Button variant="destructive" onClick={onDelete}>
        Delete This Project
      </Button>
    </DestructiveTooltip>
  );
}
```

Use `t.raw(key)` (not `t(key)`) to read the `{ label, warning }` object.

### Icon-only control

Pair every icon-only `<Button>` with both a tooltip **and** an `aria-label` so screen readers announce the action even when the tooltip does not open.

```tsx
<Tooltip>
  <TooltipTrigger asChild>
    <Button size="icon" aria-label={t("refresh")} onClick={onRefresh}>
      <RefreshCwIcon className="size-4" />
    </Button>
  </TooltipTrigger>
  <TooltipContent>{t("refresh")}</TooltipContent>
</Tooltip>
```

### Migrating an existing native `title=` — `aria-label` is not a safe swap

`title` and `aria-label` do different jobs, and swapping one for the other silently changes the accessible name:

- On an element **with content** (a button whose label is its text), `title` is only a *fallback* — the accessible name stays the content. `aria-label` **replaces** it. Adding `aria-label="Open TC-123"` to a button whose visible text is the test case title drops that title out of the accessible name, which breaks WCAG 2.5.3 *Label in Name*.
- On an element **without content** (an icon-only button), `title` and `aria-label` both supply the name, and `aria-label` is the correct choice.
- On a **non-interactive** element, `title` maps to the accessible *description*, not the name. A portalled tooltip supplies neither, so the copy becomes pointer-only. Put it in an `sr-only` child instead — see the `deleted` chips in `BacklogAuditDialog.tsx` / `BacklogSessionHistoryDialog.tsx`.

Decision order when removing a `title`:

1. Does the element already have visible text that names it? → add the tooltip, add **no** `aria-label`.
2. Is it icon-only and interactive? → tooltip **and** `aria-label` (the pattern above).
3. Is it non-interactive? → tooltip for pointer users **and** an `sr-only` child carrying the same copy.

Also: do not wrap a child in its own tooltip when an ancestor already has one. Radix does not dedupe them, so both open and stack.

### Copy guidelines

- Describe what **happens on click** based on the actual handler — trace it into the mutation / procedure / workflow before writing. Do not infer from the label.
- Follow [`ai-copy-tone.md`](../ai/ai-copy-tone.md): calm, advisory, non-authoritative. Avoid "must", "should", "best", "optimal", "required".
- For disabled-state tooltips, describe the current state **and** the re-enable condition (e.g., `Already Pushed`: *"Features from this document are already on the Roadmap. Disabled until you regenerate the Features document or clear the existing Roadmap stories."*).
- For destructive copy, name the specific irreversibility (what exactly is lost), not a generic "cannot be undone".

## ❌ DON'T

- **Don't inline English strings.**
  ```tsx
  // Bad
  <TooltipContent>Push to Roadmap</TooltipContent>
  ```
- **Don't use native `title=""` attributes.** They are painted by the OS, so they ignore the 500ms delay, the theme, the width cap, and i18n entirely. Four narrow exceptions are allowed and are the *only* ones:
  - `<iframe title="…">` — required by a11y to name the frame; it is not a tooltip.
  - `<time title="…">` — the full timestamp behind a relative label ("2 hours ago"). A hover tooltip here would fight the surrounding text.
  - **Truncation affordance on a shared primitive**, where the visible text is already ellipsised and the full string has nowhere else to go. `apps/web/modules/ui/components/select.tsx` sets one deliberately on pointer-enter. Do not add new ones outside `modules/ui/`.
  - **Controls built imperatively outside the React tree.** An overlay assembled with `document.createElement` (e.g. `apps/web/modules/saas/projects/components/ImageSelectionToolbar.tsx`, which positions over ProseMirror image nodes) has no `TooltipProvider` in scope, so `<Tooltip>` cannot wrap it. These controls take **no tooltip and no native `title`** — an `aria-label` on each button is the whole accessibility contract. If you find yourself wanting a styled tooltip here, port the overlay into the React tree (a portal) first; do not hand-roll a tooltip or reach for native `title`.

  Everything else — buttons, icon controls, status chips, anything the user is meant to act on — goes through `<Tooltip>`. The Stage 2 migration (2026-07) moved the interactive native-`title` controls onto the shared primitive; new `title=` on anything outside the four exceptions above is a regression, not precedent.
- **Don't set `delayDuration` locally unless you have a concrete reason.** The provider default is 500ms. Two carve-outs stay at `{0}` for high-frequency micro-interactions: `ColorModeToggle` and `SettingsMenu`. Anything else should match the provider default.
- **Don't use `<DestructiveTooltip>` for an action that only feels heavy** (e.g., `Push to Roadmap` is informational — it creates new items but is not data loss).
- **Don't wrap the same control in two tooltips.** If a parent already provides a tooltip, don't re-wrap the child.
- **Don't rewrite existing tooltips** when gap-filling a partially-covered file. Audit-driven coverage only touches flagged rows.

## Adding a new tooltip — workflow

1. **Classify the control** using the §When to apply criteria.
2. **Decide variant** — informational `<Tooltip>` or destructive `<DestructiveTooltip>`.
3. **Pick or add the i18n key** in the appropriate bucket in `packages/i18n/translations/en.json`.
4. **Adopt `useTranslations(<bucket>)`** in the component if it doesn't already. Add the hook near other hooks at the top of the component body.
5. **Wrap the button** with `<Tooltip>` + `<TooltipTrigger asChild>` + `<TooltipContent>` (informational) or `<DestructiveTooltip copy={t.raw(...)}>` (destructive).
6. **Add `aria-label`** on icon-only triggers.
7. **Run** `pnpm --filter web test modules/ui/components/__tests__/`, `pnpm --filter web type-check`, and `pnpm exec biome check --write <file>` before pushing.

## Classification reference — which actions are destructive

From [spec §7.2](../../docs/specs/2026-04-20-contextual-action-tooltips/spec.md):

**Destructive** (warrants `<DestructiveTooltip>`):
- Delete / Remove (records, documents, members)
- Clear (content, buffers)
- Revoke (keys, invitations, access)
- Disconnect (integrations)
- Reset (to defaults; discards customizations)
- Archive (project hidden from active lists)
- Start Fresh (pipeline reset)
- Re-process All Documents (discards embeddings)

**Informational** (use `<Tooltip>`):
- Push to Roadmap, Already Pushed, Refresh, Add Feature
- Approve, Reject (document editor)
- Update Binding, Bind as Default (prompts)
- Sync Now, Test Sync (integration probes)
- Mark Complete, Edit Project (project header)

## Testing

- Unit tests for `<DestructiveTooltip>` live at `apps/web/modules/ui/components/__tests__/destructive-tooltip.test.tsx` and cover: hover → `role="tooltip"`, keyboard focus → `role="alert"`, blur reset, `AlertTriangleIcon` with `aria-hidden`, `delayDuration` prop override, and the `label` / `warning` rendering contract.
- i18n sanity tests live at `apps/web/modules/ui/components/__tests__/tooltips-namespace.test.ts` and assert that every destructive entry has both `label` and `warning` string properties and that every `warning` starts with `"Warning: "`.
- Surface defaults are pinned at `apps/web/modules/ui/components/__tests__/tooltip-surface.test.tsx` — width cap, wrap mode, and the `--color-*` remap contract.
- The Playwright spec at `apps/web/tests/contextual-tooltips.spec.ts` exercises the top-10 anchor actions end-to-end; seeding notes live in that file.

Run after any tooltip change:

```bash
pnpm --filter web test modules/ui/components/__tests__/destructive-tooltip.test.tsx
pnpm --filter web type-check
```

## Accessibility

- Every icon-only control must have both `aria-label` and a tooltip. The tooltip is a hover/focus aid; the `aria-label` is the fallback when the tooltip does not open (mobile, assistive tech).
- Destructive tooltips emit `role="alert"` only on keyboard focus, never on hover. This ensures screen reader users are warned before activation without spamming announcements during casual mouse movement.
- The 500ms delay respects `prefers-reduced-motion` naturally — no animation loops; only a single entrance transition.

## References

- Spec: [`docs/specs/2026-04-20-contextual-action-tooltips/spec.md`](../../docs/specs/2026-04-20-contextual-action-tooltips/spec.md)
- Accessibility standard: [`frontend/accessibility.md`](./accessibility.md)
- Component standard: [`frontend/components.md`](./components.md)
- Copy tone standard: [`ai/ai-copy-tone.md`](../ai/ai-copy-tone.md)
