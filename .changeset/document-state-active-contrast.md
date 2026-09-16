---
"fabric-app": patch
---

The Active count in a project's Document State card is readable in dark mode

The three counters in the Document State card (Ready, Active, Open) are data
values, but the middle one was coloured with `text-primary`. `--primary` is
the organization's brand colour, set per organization by the theme provider
and tuned to carry a white or black label when used as a fill; it was never
meant to be body text on a dark surface. With a dark brand the Active count
rendered as near-black on the dark card, so a user saw a blank tile where the
zero should be.

The count now uses `text-foreground`, the same as the Ready count beside it.
The design rules for the app say colour is for state and brand, not for
making a number look interesting; the label underneath already says which
counter it is.
