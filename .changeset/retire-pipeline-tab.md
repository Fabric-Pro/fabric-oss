---
"fabric-app": patch
---

The Pipeline tab is retired: feature recommendations now live in Roadmap, and Features documents are marked deprecated, historical snapshots.

Fizzy #2212 (Project Suite 3D). Ships only after the Roadmap recommendation flow (3A-3C) is live in the target environment; there is no flag, by design.

Removed at every layer so nothing survives as a REST route an API key can still call:
- Web: the Pipeline project tab, `ProjectPipeline` and the two components only it used, the `tooltips.pipeline` copy, the Get Started drawer item and page tour, and the Pipeline cases in the contextual-tooltips E2E spec. Stale Pipeline wording on Overview, the Get Started tours and the PRD-source clear warning is rewritten. A stale `?tab=pipeline` link or stored tab still falls back to Overview.
- API: the `pipeline` router (`start`, `status`, `list`), `projects.stories.pushToKanban` (the document-to-Roadmap push) and `projects.stories.clear` (whose default also deleted every Features document). A router guard test keeps all three gone.
- Database: `bulkCreateStories` and `clearProjectStories`, which only those procedures called. No schema change and no data change: Features documents, pipeline-created Roadmap stories and old pipeline execution rows all stay.
- Temporal: `prdToTasksPipelineWorkflow` and the six activities only it called (`saveExternalPrd`, `extractContentViaMcp`, `pushTasksToFizzy` with the rest of the legacy Fizzy activity file, `pushTasksViaMcp`, `createPipelineDocumentPlaceholders`, `createOrUpdateStoriesDocument`). The replay suite skips the workflow type until its histories age out.

Added: a `deprecated` flag on the Features entry of the shared document-type catalog (label unchanged, since it is also the default title; listed last), read by the Create Document type list, the Documents list, the editor's type chip and the project wizard. One notice carries the approved copy and links to the Roadmap tab, shown when Features is chosen in Create Document and on an existing Features project document.

Deploy order: web first, then the Temporal worker. Before the worker rollout, check for running `prdToTasksPipelineWorkflow` executions in each namespace and drain or terminate them.
