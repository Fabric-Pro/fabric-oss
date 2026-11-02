# UI Style Guide

- **Audience**: Engineers and AI agents
- **Owner**: Frontend platform maintainers

> **Precedence**: This document is a **strict specification**, not guidelines. Treat it as mandatory for all frontend implementation.
>
> **Related**: For React component patterns and CSS methodology, see `fabric/standards/frontend/components.md` and `fabric/standards/frontend/css.md`. This guide focuses on visual consistency, design tokens, and component reuse.

---

## 1. Design Tokens

Use **only** shared tokens for colors, spacing, and typography. No inline styles. No hardcoded hex colors. No arbitrary padding or margins.

### Colors (Semantic Tokens)

Use Tailwind utilities that map to CSS variables. Never use hex values or arbitrary color classes.

| Token | Tailwind Usage | Purpose |
| --- | --- | --- |
| `background` | `bg-background` | Page/surface background |
| `foreground` | `text-foreground` | Primary text |
| `primary` | `bg-primary`, `text-primary`, `border-primary` | Primary actions, links |
| `primary-foreground` | `text-primary-foreground` | Text on primary |
| `primary-hover` | `hover:bg-primary-hover` | Primary button hover fill |
| `primary-active` | `active:bg-primary-active` | Primary button pressed fill |
| `primary-ink` | `text-primary-ink` | Brand-aware inline text/link ink |
| `secondary` | `bg-secondary`, `text-secondary` | Secondary actions |
| `muted` | `bg-muted`, `text-muted-foreground` | Muted backgrounds, secondary text |
| `accent` | `bg-accent`, `text-accent-foreground` | Hover states, highlights |
| `destructive` | `bg-destructive`, `text-destructive` | Errors, delete actions |
| `destructive-hover` | `hover:bg-destructive-hover` | Destructive button hover fill |
| `destructive-active` | `active:bg-destructive-active` | Destructive button pressed fill |
| `success` | `bg-success`, `text-success` | Success states |
| `border` | `border-border` | Borders |
| `input` | `border-input`, `bg-input` | Form inputs |
| `ring` | `ring-ring` | Focus rings |
| `card` | `bg-card`, `text-card-foreground` | Card surfaces |
| `popover` | `bg-popover`, `text-popover-foreground` | Overlays |
| `highlight` | `bg-highlight`, `text-highlight-foreground` | Emphasis |
| `highlight-ink` | `text-highlight-ink` | Warning text/icons on neutral surfaces |

### Radius

| Token | Tailwind | Resolved Size | Usage |
| --- | --- | --- | --- |
| `--radius-lg` | `rounded-lg` | `6px` (`calc(var(--radius) + 2px)`) | Cards, dialogs, popovers |
| `--radius-md` | `rounded-md` | `4px` (`var(--radius)`) | Buttons, inputs, select triggers |
| `--radius-sm` | `rounded-sm` | `3px` (`calc(var(--radius) - 1px)`) | Menu items, badges, checkboxes |

### Usage Rule

```tsx
// ✅ CORRECT - Semantic tokens
<div className="bg-primary text-primary-foreground rounded-lg p-4">
<Button className="bg-destructive text-destructive-foreground" />

// ❌ WRONG - Hardcoded values
<div className="bg-[#ea580c] text-white" />
<div style={{ padding: "16px" }} />
```

---

## 2. Component Library

Reuse existing components from `apps/web/modules/ui/components/`. Import via `@ui/components`.

**Rule**: Do not create page-specific UI components. Do not fork styles or copy-paste variations. If a required component does not exist, propose a reusable component instead of implementing custom UI.

### Available Components

| Category | Components |
| --- | --- |
| **Layout** | Card, Tabs, Accordion, Collapsible, Separator, ScrollArea, Breadcrumb |
| **Forms** | Button, Input, Textarea, Select, Checkbox, RadioGroup, Switch, Form, Label |
| **Overlays** | Dialog, Sheet, Popover, DropdownMenu, Tooltip, AlertDialog, HoverCard |
| **Feedback** | Toast, Alert, Badge, Progress, Skeleton |
| **Other** | Avatar, Command, Table, Calendar, DatePicker, Carousel |

### Import Pattern

```tsx
import { Button } from "@ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@ui/components/dialog";
```

---

## 3. Layout and Spacing

Use the existing spacing system consistently. Align with current layouts (cards, grids, sections).

### Card Pattern

```tsx
<Card>
  <CardHeader className="flex flex-col space-y-1.5 p-6 pb-4">
    <CardTitle>Title</CardTitle>
    <CardDescription>Description</CardDescription>
  </CardHeader>
  <CardContent className="p-6 pt-0">Content</CardContent>
  <CardFooter className="flex items-center p-6 pt-0">Footer</CardFooter>
</Card>
```

- Header: `p-6 pb-4`, `space-y-1.5`
- Content: `p-6 pt-0`
- Footer: `p-6 pt-0`

### Form Controls

- Height: `h-9` (default)
- Padding: `px-3`, `py-2` (or `py-1.5` for inputs)
- Radius: `rounded-md`
- Border: `border border-input`

### Sections and Grids

- Section gap: `gap-4` or `space-y-4`
- Grid: `grid gap-4` or `flex flex-col gap-4`

### Shadows

In-flow cards, buttons, and inputs are flat (`shadow-none`) and rely on `1px` borders (`border-border` / `border-input`). Drop shadows are reserved for floating overlays and switch thumbs:

| Class | Usage |
| --- | --- |
| `shadow-none` | Cards, buttons, inputs (default in-flow surfaces) |
| `shadow-sm` | Switch thumbs |
| `shadow-md` | Dropdown menus, select popovers, popovers, hover cards |
| `shadow-elevated` | Dialogs, alert dialogs, sheets |

### Layering

Pick a layer from this ladder. Do not invent a value, and do not raise one to
win a fight with a neighbour — a surface that loses is usually in the wrong
class, not the wrong rung.

| Layer | Value | What sits here |
| --- | --- | --- |
| Shell notice | *(none)* | In-flow notices in the shell notice region |
| Backstop banner | `z-10` | The sticky pre-reload warning |
| Sidebar navigation | `z-30` | `NavBar` |
| Advisory dock | `z-40` | Floating, dismissible AI notices |
| Overlays | `z-50` | Radix dialogs, sheets, popovers, dropdowns, tooltips |
| Consent banner | `z-[100]` | The cookie-consent prompt |
| Guided tour | `200` | The Get started spotlight (inline style, portalled) |

**A shell notice takes no z-index at all.** It sits in normal flow, so a sibling
cannot cover it and there is nothing to out-rank. Where a route paints its own
viewport-fixed chrome the region yields instead of competing — see
`isFullBleedRoute` in `apps/web/modules/saas/shared/lib/shell-layout.ts`. This
holds only while no ancestor of the mount point establishes a stacking context
(`transform`, `filter`, `backdrop-filter`, `will-change`); none does today.

**Never hand-write the sidebar offset in new code.** Import it from
`shell-layout.ts`. Four hand-written copies of one measurement across two files
is what produced Fizzy #2489.

**The values above are the ones the app already ships, recorded so they can be
reasoned about — not a licence to invent new arbitrary values.** Rule 1 of
§6 still stands: reach for a token, and add a rung here only when a genuinely
new layer appears.

**Known exceptions, ticketed separately.** These sit outside the rules above
today and are being reconciled, so do not read them as precedent.

| Surface | Deviation |
| --- | --- |
| Copilot sidebar launcher | `z-30`, sharing the advisory dock's rectangle |
| Kanban toast stack, `ExcalidrawPreview`, `FrameVizShell` | `z-[9999]` |
| Sonner toaster | Its own default, far above everything here. It cannot be out-ranked — keep surfaces out of its top-right corner rather than trying |
| `FabricAIClient` | Restates the sidebar offset by hand. Correct today, including its collapsed arm, but not pinned to `NavBar` by the guard test |
| Nine wrappers across five page components | Hardcode the collapsed offset with no collapse awareness, so they are wrong whenever the sidebar is expanded |

---

## 4. Typography

- **Headings**: `font-display` (via CSS variable), `font-semibold`, `letter-spacing: -0.025em` (`h1`–`h2`) and `-0.015em` (`h3`–`h6`) in `@layer base`
- **Body**: `text-foreground`
- **Muted/secondary**: `text-muted-foreground`
- **Sizes**: `text-sm`, `text-base`, `text-lg`, `text-xl`, `text-2xl`

### Heading Scale

- `text-2xl` / `text-xl` — Page titles
- `text-lg` — Section titles, dialog titles
- `text-base` — Mobile form controls (`text-base md:text-sm`)
- `text-sm` — Primary body text (`14px`), desktop controls, labels
- `text-xs` — Secondary captions, table column headers

---

## 5. Interactions and UX

- Keep interactions minimal and predictable
- No decorative animations
- No experimental UX patterns
- Follow existing hover, focus, and loading behaviors

### Focus States

- Use `focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background` on buttons, toggles, and tabs, `focus-visible:outline-hidden focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring` on text inputs, and `focus:outline-hidden focus:border-ring focus:ring-1 focus:ring-ring` on `SelectTrigger` for crisp Warm Bright Orange focus indicators
- Prefer `focus-visible:outline-hidden` / `focus:outline-hidden` over `outline-none` so `forced-colors: active` (Windows High Contrast) retains a visible focus outline

### Loading States

- Button: `loading` prop shows spinner
- Disabled: `disabled:opacity-50`, `disabled:pointer-events-none` (buttons) or `disabled:cursor-not-allowed` (form controls)

### Transitions

- Use `transition-colors duration-150` for interactive controls (buttons, inputs, selects, menu items, table rows)
- Do not add scale-bounce transforms (`active:scale-*`) to standard workspace buttons or controls

### Pagination

- Paged lists with a known total (admin tables, member lists, history and log tables) use the shared `Pagination` component (`apps/web/modules/saas/shared/components/Pagination.tsx`). Do not build your own previous/next controls.
- The component shows the range ("1 – 10 of 240"), numbered pages with the first and last page and ellipses for gaps, and a "Go to page" input. Do not hide any of them.
- When one screen renders two pagers, pass distinct `navigationLabel`, `goToPageLabel`, `previousLabel` and `nextLabel` values so screen-reader users can tell them apart.
- Keep page, search, filter and sort in the URL (`nuqs`), and return to page 1 when search, filter or sort changes.
- While the next page loads, keep the current rows on screen (`placeholderData: keepPreviousData`), key rows by record ID, and show the full loading state only when there is no data yet.
- Feeds read in order without a meaningful total (chat history, notifications, activity streams) use "Load more" or infinite scroll instead.

---

## 6. Mandatory Rules (Non-Negotiable)

1. **Design tokens only** — Use shared tokens for colors, spacing, typography. No inline styles. No hardcoded hex. No arbitrary values.
2. **Component reuse** — Use `@ui/components`. Do not create page-specific UI components. Do not fork or copy-paste component styles.
3. **No new colors** — Do not introduce new colors. Use existing semantic tokens.
4. **No custom primitives** — Do not build custom dropdowns, modals, or buttons. Use Dialog, Select, DropdownMenu, Button.
5. **No unsolicited design changes** — Do not "improve" design without explicit request. Match existing patterns.

---

## 7. Forbidden Actions

| Forbidden | Why |
| --- | --- |
| Inline styles | Breaks theming, inconsistent |
| Hardcoded hex colors | Breaks dark mode, org theming |
| Arbitrary padding/margins | Inconsistent spacing |
| Page-specific visual tweaks | Diverges from system |
| Custom dropdowns, modals, buttons | Duplicates existing components |
| Introducing new colors | Expands token set unnecessarily |
| Decorative animations | Adds noise, accessibility concerns |

---

## 8. Implementation Process

### Before Coding

1. Review existing UI in the project for similar features
2. Identify reusable components from `@ui/components`
3. Match spacing, typography, and layout patterns already in use

### While Coding

- Prefer composition over customization
- Keep components simple and predictable
- Match existing naming conventions
- Use `cn()` from `@ui/lib` for class merging

### After Coding

- Re-check against this guide
- Ensure the UI visually fits existing pages
- Verify no inline styles, hardcoded colors, or custom primitives

---

## 9. Quick Reference

```plaintext
Colors:    bg-primary, text-muted-foreground, border-border
Spacing:   p-6, gap-4, space-y-4
Radius:    rounded-md, rounded-lg
Shadows:   shadow-sm, shadow-elevated
Components: @ui/components
Utility:   cn() from @ui/lib
```

---

**If unsure at any point**: Stop and ask for clarification instead of assuming.
