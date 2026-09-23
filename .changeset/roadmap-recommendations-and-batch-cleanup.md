---
"fabric-app": patch
---

The Roadmap now helps you start: pull work from your PM tool or have Fabric recommend features, review them in the inbox, and remove an AI batch safely.

Internal context (Project Suite 3A/3B/3C, Fizzy #2204, #2208, #2211):

- 3A: an empty Roadmap shows "Start Building Your Roadmap" with Pull, Recommend and Do both. Backlog, Done, hidden and declined items don't count as populated. A ⋯ actions menu holds the mature-Roadmap entries. PM pull/sync/import are gated on the capability engine (FR51-54). A durable PM_STORY_SYNC background job backs "Processing" across reloads. Do both continues only on a COMPLETED job with no failures. A pull with nothing new is a success. PM sync settings are disabled until a PM tool is connected.
- 3B: a Temporal roadmapRecommendationWorkflow gathers context and runs the analyzer in a new recommend mode, persisting one ROADMAP_RECOMMENDATION proposal batch (FR55-59 gated). Accepting stamps StorySource.AI_RECOMMENDED plus the batch id, pins Feature and requires the Clean Spec prompt. Unaccepted recommendations stay in review. Retry doors return the batch to review, and the Teams/Slack approve doors refuse the source. Behind ROADMAP_RECOMMENDATIONS (default off, per org).
- 3C: AI Recommended label and filter, Protect Work Item, dismissible guidance, and Remove AI Recommended Items: hide-based, per-item, following governed review, with an edited-items warning and HIDDEN when no batch is eligible (FR60). Behind AI_RECOMMENDED_LIFECYCLE (default off, per org).
- Migrations: three additive files (two enum migrations, four nullable user_story columns). Needs a temporal-worker deploy.
