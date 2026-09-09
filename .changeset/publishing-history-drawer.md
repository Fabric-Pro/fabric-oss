---
"fabric-app": patch
---

Move refresh history behind a button, and mark it when a run has failed

*"What is this? I wouldn't even know it's here with such a long list, but still don't understand what that is"* (Fizzy #1851). The refresh history was the last block on the Inbox, rendered under every state — a table of runs sitting below a list of topics, with nothing saying what it was for.

It now opens in a drawer from a button in the page header. A table of runs is reference material: worth reaching for when the list above is thinner than expected, and out of the way the rest of the time. A dot on the button means the most recent refresh **failed** — the one case worth interrupting for, since it is why the list is short. A run that found nothing is ordinary and the list already says so itself.

The get-started anchor moved onto the button rather than being deleted, and the tour copy moved with it — a spotlight cannot point at something that is not on screen until you click, and moving an anchored component without moving its copy is what turns the drift test red.

One placement detail worth keeping: the drawer renders at the bottom of the component, beside the other dialogs, and deliberately not inside the header. It is a Radix root, so mounting it in the header allocates a `useId` ahead of every row and renumbers the `radix-_r_N_` ids the flag-off parity snapshot pins — a red test with nothing to do with what changed.
