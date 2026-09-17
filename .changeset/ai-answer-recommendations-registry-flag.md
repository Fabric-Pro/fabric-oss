---
"fabric-app": patch
---

Administrators can now turn AI-recommended answers to open questions on for one organization or for the whole instance from the admin console, and the "Auto-propose answers" switch in a feature's Summary & Questions tab now appears only where those recommendations are enabled.

Recommendations were previously controlled by an organization setting that could only be changed directly in the database. It is replaced by the `AI_ANSWER_RECOMMENDATIONS` flag, off by default and resolved for the organization that owns the project. A migration gives every organization that already had recommendations enabled a per-organization override, unless an override for that flag already existed; any override written for the flag by hand before this release takes effect with it. Turning the flag off stops new suggestions and hides suggestions already stored, in the feature editor and in the Decision Log API. The old database setting is kept for the previous build during the deploy but is no longer read, so changing it has no effect.

The application no longer defines or passes through configuration values and environment variables that nothing read — `NEXT_PUBLIC_IS_LIVE`, `ENABLE_TEMPORAL_WORKFLOWS`, the server-side `FABRIC_FEATURE_INCIDENT_BANNER`, `FABRIC_FEATURE_INTEGRATION_HEALTH_BADGES` and `FABRIC_FEATURE_ADMIN_MONITORING_DASHBOARD`, and the client-side `NEXT_PUBLIC_FABRIC_FEATURE_BURN_RATE_ALERTS` — so there is no change in behaviour, and setting any of them has no effect. Comments that described the wrong default for several flags were corrected.
