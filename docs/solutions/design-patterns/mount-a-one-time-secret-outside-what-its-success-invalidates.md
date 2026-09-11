---
title: "A view holding a one-time secret must outlive everything its own success can unmount"
date: 2026-09-11
category: design-patterns
module: web projects api-keys
problem_type: design_pattern
component: full_stack
severity: high
applies_when:
  - "A dialog shows a value the server stores only as a hash and cannot return again"
  - "A surface is rendered inside a branch whose condition its own mutation changes"
  - "A panel refetches on every successful mutation and gates its children on the result"
  - "Adding a second entry point to a flow that already has one"
tags: [one-time-secret, api-keys, react, mount-lifetime, refetch, dialogs]
related_components: [connect-cli-dialog, project-readiness-panel, cli-connection-nudge]
audience: engineers building any surface that displays an unrecoverable value
owner: platform team
---

## Context

Fizzy #2457 added a dialog that mints an organization API key and shows it once. The server keeps a hash; if the plaintext leaves the screen it is gone, and what remains is a live ninety-day credential nobody holds.

The dialog is opened from two places: a prompt on the project page, and a row in the readiness checklist. Both sit under a readiness provider that **refetches after any successful mutation** and gates its children on the result.

That combination is a trap with a very short fuse. Issuing a key *is* a successful mutation. The refetch it triggers re-evaluates the conditions the surrounding surfaces are rendered under — at the exact moment the dialog holds the only copy of the secret.

The prompt's mount got this right and said why. The checklist row's mount carried the same reasoning in a comment and was still wrong: the panel early-returns a different tree four hundred lines above the dialog's JSX when it is collapsed, so the dialog was inside a branch its own author had not looked at.

That one turned out not to be reachable — the modal overlay blocks the collapse control, and nothing collapses the panel automatically. But the protection is **emergent**: it comes from the dialog library's behaviour, not from a decision anyone made, and no test asserts it.

## Guidance

**Mount a view holding an unrecoverable value as high as its lifetime needs to be, not where its trigger happens to live — and verify that by counting the conditions between the mount and the root.**

The rule has two halves, and the second is the one people skip.

**Half one — do not mount it inside anything its own success invalidates.** If issuing the key flips an eligibility flag, and the surface is rendered under that flag, the surface unmounts on success. Put the dialog beside the branch, not in it, and let its lifetime belong to a component that does not depend on the outcome.

**Half two — count every condition between that mount point and the root, including ones outside your diff.** A mount is broken by conditions its own change does not show. On this branch the prompt was correctly placed relative to its own visibility flag, and then placed inside a page-level "hide chrome" condition belonging to a different feature — which unmounted it on a mode toggle, resetting a per-mount latch and double-counting an analytics impression. Its sibling three lines above had been deliberately hoisted out of exactly that condition, by someone who had looked.

The practical form: when you add a mount point, read outward from it to the component root and list the conditions you pass through. If any of them can change for a reason unrelated to your feature, either hoist above it, or render it hidden rather than unmounted (`hidden` as an attribute, so the element also leaves the accessibility tree and the parent's spacing rhythm).

**Corollary — a second entry point needs the same audit, and usually shares state.** When the same flow can be started from two surfaces, any state one of them introduces to reflect "this just happened" belongs on the nearest common ancestor, not in whichever surface was written first. Otherwise the second door bypasses it silently.

## Why This Matters

The damage from losing a one-time secret is asymmetric, and that asymmetry is what makes this worth a rule rather than a code review note.

Losing a value that can be re-fetched costs a click. Losing this one leaves a **live credential with a ninety-day lifetime that nobody holds and nobody knows to revoke** — a security tail rather than an inconvenience. The mitigation on this branch was to make the issuing dialog refuse casual dismissal while an uncopied secret is on screen, mirroring an existing blocking-gate component in the same repo, and to announce the refusal in a live region so the constraint is not silent.

The mount-lifetime half matters because it fails in a way that testing does not naturally cover. A component test mounts the component; it does not mount it under the four conditions the real page wraps it in. Both mount defects on this branch were invisible to every unit test and visible immediately to a reviewer who read outward from the JSX instead of at it.

## When to Apply

- **Any surface displaying a value the server cannot return again** — a minted key, a rotated token, a webhook secret, a recovery code.
- **Any surface under a provider that refetches on mutation success** — which in this codebase includes every project readiness consumer.
- **Whenever you add a mount point**, whether or not a secret is involved: count the conditions to the root. The per-mount analytics latch that double-fired here had nothing to do with secrets.
- **Whenever a flow gains a second entry point** — audit both mounts, and lift any "just happened" state to the common ancestor.

## Examples

The mount that was right, and the comment that now says why truthfully:

```tsx
{visible && <Alert>{/* the prompt */}</Alert>}

{/* The issuing view, a SIBLING of the prompt and outside its visibility branch.
    Eligibility is server-resolved and can change on any refetch for reasons this
    component does not control, so a view holding an unrecoverable secret must not
    depend on it. */}
{organizationId && <ConnectCliDialog open={issuingViewOpen} … />}
```

The mount that was wrong, and why no test saw it:

```tsx
// ProjectReadinessPanel, line ~597
if (!isExpanded) {
    return <ReadinessSummaryStrip … />;   // a different tree entirely
}
// …four hundred lines later…
<ConnectCliDialog open={connectCliOpen} … />   // unreachable when collapsed
```

Hiding rather than unmounting, when a mount must sit under someone else's condition:

```tsx
// Not {!shouldHideChrome && <CliConnectionNudge />} — that unmounts it.
<CliConnectionNudge key={projectId} hidden={shouldHideChrome} … />
```
