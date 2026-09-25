---
"fabric-app": patch
---

Prompt pages now say when they could not load and offer a retry, instead of showing an empty library, "not found", or a false "no organization prompt" picture.

Fizzy #2249. Every failed prompt query used to degrade to a confident, wrong state:

- Prompt detail, enhance page and preview sheet: any `prompts.get.byId` failure read as "Prompt not found". NOT_FOUND (absent id or outside the caller's tenant, deliberately indistinguishable) now says "does not exist, or you do not have access"; every other failure says "Could not load this prompt" with Try again. The detail page's Back button also used the personal path in an organization context.
- Prompt catalog: a failed `prompts.catalog.list` rendered every action as "No prompt bound — uses the built-in default". Now a load-failure state.
- Settings prompt management: a failed list rendered "No prompts found". Now a load-failure state.
- Governance dashboard: while the catalog read was in flight (including React Query's retries) both sections listed all actions as having no organization override. Sections now wait for data.
- Prompt detail save: a failed `prompts.bindings.listForPrompt` read made the FR21 shared-edit warning silently disappear. A content save now confirms that the prompt's reach could not be checked.
- Set as default dialog: a failed bound-actions read left "Also apply to" empty without saying why. It now shows a non-blocking notice with retry.

One shared `LoadFailure` component carries the copy and retry button, replacing the two inline copies in PromptsList and PromptGovernanceDashboard. `isPromptNotFound` is the single NOT_FOUND predicate.

Not changed: the app-wide oRPC client interceptor's logging policy (4xx deliberately not logged).
