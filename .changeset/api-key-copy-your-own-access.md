---
"fabric-app": patch
---

The API Keys settings page now says plainly that a key is yours and carries only the access you already have in the app

Fizzy #2380. The page hero read "Create and manage the keys you use to reach this organization from outside the app", which — sitting under the `ORGANIZATION` section label and the title `API Keys` — read as though a key opened the whole organization. Three signals all pointed the same wrong way, and the card below it was the only thing correcting the impression.

The hero now leads with the rule instead: "Keys are personal. Yours reaches Fabric from outside the app with the same access you have inside it." The page `metadata.description` carried the same misframe and moves with it.

One knock-on in `OrganizationApiKeysSettings`: the owner variant of the card opened "they are personal, not shared", which stuttered against the hero's new first two words for owners only. It now reads "not the organization's" — the same point, stated as the negation that actually kills the misread.

Copy only. The `label="Organization"` stays: it names the settings area and is shared by five sibling pages. The title stays `API Keys` too, so the settings nav, the `OrgSettingsLayoutClient` title map and the `settings-api-keys` get-started registry entry are all untouched and no drift-test surface moves.
