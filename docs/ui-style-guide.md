# UI Style Guide

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
| `secondary` | `bg-secondary`, `text-secondary` | Secondary actions |
| `muted` | `bg-muted`, `text-muted-foreground` | Muted backgrounds, secondary text |
| `accent` | `bg-accent`, `text-accent-foreground` | Hover states, highlights |
| `destructive` | `bg-destructive`, `text-destructive` | Errors, delete actions |
| `success` | `bg-success`, `text-success` | Success states |
| `border` | `border-border` | Borders |
| `input` | `border-input`, `bg-input` | Form inputs |
| `ring` | `ring-ring` | Focus rings |
| `card` | `bg-card`, `text-card-foreground` | Card surfaces |
| `popover` | `bg-popover`, `text-popover-foreground` | Overlays |
| `highlight` | `bg-highlight`, `text-highlight-foreground` | Emphasis |

### Radius

| Token | Tailwind | Usage |
| --- | --- | --- |
| `--radius` | `rounded-lg` | Cards, dialogs |
| `--radius-md` | `rounded-md` | Buttons, inputs |
| `--radius-sm` | `rounded-sm` | Small elements |

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
- Padding: `px-3`, `py-2` (or `py-1` for inputs)
- Radius: `rounded-md`
- Border: `border border-input`

### Sections and Grids

- Section gap: `gap-4` or `space-y-4`
- Grid: `grid gap-4` or `flex flex-col gap-4`

### Shadows

| Class | Usage |
| --- | --- |
| `shadow-xs` | Inputs, subtle elevation |
| `shadow-sm` | Cards, buttons |
| `shadow-elevated` | Cards on hover, modals |

---

## 4. Typography

- **Headings**: `font-display` (via CSS variable), `font-semibold`, `tracking-tight`, `letter-spacing: -0.025em`
- **Body**: `text-foreground`
- **Muted/secondary**: `text-muted-foreground`
- **Sizes**: `text-sm`, `text-base`, `text-lg`, `text-xl`, `text-2xl`

### Heading Scale

- `text-2xl` / `text-xl` — Page titles
- `text-lg` — Section titles, dialog titles
- `text-base` — Body
- `text-sm` — Secondary text, labels

---

## 5. Interactions and UX

- Keep interactions minimal and predictable
- No decorative animations
- No experimental UX patterns
- Follow existing hover, focus, and loading behaviors

### Focus States

- Use `focus-visible:ring-ring`, `focus-visible:ring-[3px]` for focus indicators
- Ensure `outline-none` with visible ring replacement

### Loading States

- Button: `loading` prop shows spinner
- Disabled: `disabled:opacity-50`, `disabled:cursor-not-allowed`

### Transitions

- Use `transition-all duration-200` or `duration-300` for state changes
- Prefer `transition-colors` for color-only changes

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
