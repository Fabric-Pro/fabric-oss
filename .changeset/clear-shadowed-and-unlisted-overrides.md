---
"fabric-app": patch
---

Organization admins can clear their organization's prompt override even when their own personal default is in force, and overrides saved for actions no longer listed can now be cleared from the Actions tab.

Fizzy #2248 post-ship follow-up. ActionPromptList offered "Clear override" only on the variant in force for the viewer, so an admin with a personal default on an action could not see the clear control on the organization's override; it now keys on the tier's own default (isDefault). PromptCatalog adds a "No longer listed" section for live ORG/USER overrides whose action id is not in listPromptActions() — seen on staging as an org override at feature_clean_spec_generator:DRAFT:FEATURE, written before the Clean Spec default moved to CLEAN_SPEC — offering clear only, never "Use this"/"Set for org". The "no lower tier, no clear" rule from the original implementation is unchanged by decision.
