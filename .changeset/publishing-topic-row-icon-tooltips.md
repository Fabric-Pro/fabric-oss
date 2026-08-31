---
"fabric-app": patch
---

Explain the Publishing Suite topic row's two icon buttons on hover, so the envelope and the alarm clock say what they do

Review feedback on the 1D Inbox (Fizzy #2265): the read/unread and snooze
controls are icon-only, and a sighted mouse user had no way to find out what
either one does.

They were never inaccessible — both carry an `aria-label`, so a screen reader
has always announced them. The gap was specifically visual, and that is the
half this fills: `aria-label` stays exactly as it was and remains the
accessible name, with the tooltip added alongside as the sighted equivalent.

Copy follows the house style for `tooltips.*` and describes the effect rather
than restating the button label — "Snooze" tells you nothing you could not
guess from the icon, whereas "Hide this topic from the Inbox until a date you
pick. It comes back on its own." answers the question the icon actually raises.
Four strings, one per control per state, in a new `tooltips.publishing` bucket.

Two details worth recording:

- The guided tour anchors on the snooze button via `data-onboarding-target`.
  Radix's `TooltipTrigger asChild` clones the trigger onto that same button, so
  the attribute survives the wrapper — moving it up to the tooltip would break
  the get-started drift test. There is now a comment at the call site saying so.
- Radix suppresses tooltips on a `disabled` trigger, and both buttons disable
  while a mutation is in flight, so the hint is briefly unavailable mid-write.
  Accepted rather than worked around: the alternative is `aria-disabled` plus a
  hand-rolled click guard on a control whose disabled window is a few hundred
  milliseconds.

The tests pin one sharp edge. `next-intl` is mocked globally as `t(key) => key`,
so a component asking for a key that does not exist renders the key itself and
every component assertion still passes. The four keys are therefore declared
once in the test and used both to drive the component assertions and to check
the catalogue, so a typo fails the first and a missing entry fails the second.
