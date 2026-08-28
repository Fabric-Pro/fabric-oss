---
"fabric-app": patch
---

Dismissing a readiness-checklist callout now closes it, instead of opening the Get started drawer over the component it just pointed at

Two surfaces raise the single-component spotlight, and they need different exits. The drawer's "Show me" should hand the user back to the drawer they were reading. `GET_STARTED_SPOTLIGHT_EVENT` — raised from outside the drawer, with the project readiness checklist as its first caller — should close to nothing, because the user never opened a drawer.

Both ran through one `endSpotlight` that unconditionally did `setMode("drawer")`. So clicking "Got it" on a callout raised from a checklist row opened a full-height drawer on top of the very thing the callout had just spotlighted, and the next click landed on the drawer instead of the control the user had been sent to.

The controller now records where the spotlight was launched from (`spotlightFromDrawerRef`, set at both entry points) and `endSpotlight` returns there — drawer for "Show me", idle for the event. Neither caller changes.

Found while QA-ing the readiness checklist on staging: the drawer opened over "Add Context" and swallowed the click.

Covered by `GetStartedController.spotlightOrigin.test.tsx` — event-raised spotlight closes to nothing on both "Got it" and Dismiss, drawer-raised still returns to the drawer, and an earlier "Show me" does not leak its origin into a later event spotlight. Mutation-checked: restoring the unconditional `setMode("drawer")` fails three of the four.
