---
"fabric-app": patch
---

The Set as Default dialog's "could not load this prompt's latest version" notice now appears at the top of the dialog, where it is visible on a phone.

Fizzy #2249, found by the ui-ux-validation sweep on staging. At 375×667 the notice sat at the bottom of the dialog's scroll area and was clipped out of view above the disabled Set as Default button. It now renders directly under the prompt card, above the form fields. A test asserts it precedes the Agent field.
