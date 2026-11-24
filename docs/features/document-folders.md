# Document Folders

How a project editor connects OneDrive and SharePoint folders whose files Fabric imports as project context, how each read keeps them in step with the drive, who sees what, and how to roll the feature out.

- **Audience**: Developers extending document folders or project context ingestion; operators enabling the feature for an organization
- **Owner**: Projects / Platform team

## What it is

A project editor (`PROJECT_UPDATE` on the project, with their own Microsoft connection) picks folders from their own OneDrive and from SharePoint document libraries on the project's **Context** tab, and may give each a description of up to 500 characters. Fabric imports the supported files in each folder and its subfolders as ordinary project context, re-reads the folders every 30 minutes and on demand, and follows the drive: new files are imported, renamed and moved files keep their context, edited files are imported again, and files that leave the folder are removed from context. The folder's description reaches the model as the source guidance of its files. The terms are defined in [CONCEPTS.md](../../CONCEPTS.md): Document folder, Format vocabulary.

The SharePoint side of the picker finds sites by search and by the sites the person follows, then lists each site's document libraries, then their folders. When `/sites` answers with any 4xx, as it does for a personal Microsoft account, the picker says SharePoint is not available for the account. Files shared with the person from other drives are not browsable.

Document folders are separate from the OneDrive transcript folders, which read only a folder's top level for meeting transcripts and never remove anything. The two kinds keep separate tables and separate workflows. Connecting is refused, naming the folder in the way, when the folder:

- is already connected as a transcript folder;
- holds, or lies inside, a connected transcript folder or another connected document folder in the same drive (paths compare by segment and without case, so `/Sales` does not hold `/Sales 2`);
- would take the project past 20 document folders.

A transcript folder connect is refused the same way when it overlaps a document folder. Choosing an already connected document folder again is a reconnect.

## Where the code lives

| Concern | Location |
|---|---|
| Tables | `ProjectDocumentFolder`, `ProjectDocumentFolderFile` in `packages/database/prisma/schema.prisma` |
| Queries | `packages/database/prisma/queries/projects/document-folders/` (connect, list, reconciliation, removals, imports, read lifecycle) |
| Guidance inheritance | `packages/database/prisma/queries/projects/folder-guidance.ts` |
| Graph helpers | `packages/integrations/src/microsoft/drive-folder.ts` (tree listing, lookup by id, download, SharePoint discovery) |
| API | `projects.documentFolders.*` in `packages/api/modules/projects/procedures/document-folders/`; the flag gate in `packages/api/modules/projects/lib/cloud-drive-folders-feature.ts`; refusal messages in `packages/api/modules/projects/lib/folder-connect-refusal.ts` |
| Sync | `packages/temporal/src/workflows/document-folder-sync.ts`, `packages/temporal/src/activities/document-folder-sync.ts` |
| Context tab | `apps/web/modules/saas/projects/components/document-folders/` (picker, folder cards, file list) |

## Tenancy and access

Both tables carry a NOT NULL `organizationId`, use the `user_owned` RLS policy like transcript folders, and are registered with the tenant extension by `projectId`. Every procedure loads the project row, refuses an input organization that is not the project's, and answers NOT_FOUND while the flag is off for the project's organization. Listing takes `PROJECT_READ`; every other procedure takes `PROJECT_UPDATE`.

A folder is read only with its **reader's** own Microsoft connection, never one shared with the organization. The reader is the person who last connected or reconnected it. Before every read, removal lookup and import, the sync checks again that the project has an organization, that it is the folder's, that the flag is on for it, and that the reader may still add context to the project. The organization always comes from the project row; the one in the workflow input is only a hint. Microsoft scopes stay read-only: the connection already holds `Files.Read.All` and `Sites.Read.All`, so connecting needs no new consent.

Connecting, reconnecting, editing the description, confirming held removals and disconnecting each write an audit row (`project.document_folder.*`). The description's text never goes into the audit row.

## What is read

| Limit | Value |
|---|---|
| Depth | The connected folder is level 0. Files in folders down to 5 levels below it are listed; a deeper folder is not opened, and the listing still counts as complete. |
| Scan cap | A read looks at up to 5,000 items, files and folders. A folder with more is read in part, and its removals pause as too large. |
| Import window | The 500 most recently modified supported files of a folder. A newer file displaces the oldest imported one, which is removed from context and recorded as skipped with the cap reached. A file skipped for the cap comes back only through the window, never on a new version alone. Only a complete listing moves the window. |
| Formats and sizes | The project context upload vocabulary (`packages/utils/lib/context-upload.ts`) and its limits (`packages/utils/lib/upload-size-limits.ts`): 10 MB for images and spreadsheets, 20 MB for documents and other files. PowerPoint is not in it, so `.pptx` files are skipped, as they are refused for uploads. |
| Folders | At most 20 per project, and at most 20 in one connect. |

A file the vocabulary does not admit is recorded as skipped (unsupported). One over its type's limit, by the listed size or by the downloaded size, is skipped as too big; a download is cut off at the largest limit, so an oversized file is never held whole. Items that are neither a file nor a folder, such as shortcuts to another drive, are skipped by the listing.

Each imported file becomes a `ProjectContext` of the type the vocabulary assigns (FILE, DOCUMENT, SPREADSHEET or IMAGE), never INTEGRATION. Its `metadata.provider` is `onedrive-documents` or `sharepoint-documents`, apart from the transcript folders' `onedrive-folder`, and its metadata also holds the folder id, the drive item id and the file's path below the folder. The context belongs to the reader. It is processed by `projectContextProcessingWorkflow` as a child with the id `project-context-processing-{contextId}`.

## How files stay in step

One workflow per project, `documentFolderSyncWorkflow` with the id `document-folder-sync-{projectId}` on the `project-documents` queue, runs every document folder of the project; its activities run on `project-operations`. Connecting and **Sync now** both use signal-with-start (signal `syncDocumentFoldersNow`), so either restarts a run that has ended. The procedure wakes the sync whether or not a pass is running, and signals during a pass coalesce into one more pass. The Context tab still disables a folder's Sync now button while that folder is being read. Each pass:

1. reads the due folders one at a time;
2. after each complete read, looks up the files two complete reads missed;
3. deletes the contexts of files that left, changed or fell out of the window, at most 200 per pass;
4. imports the files waiting in the due folders, 20 at a time;
5. waits for Sync now, or for the earlier of 30 minutes and the earliest time a throttled folder may be read again.

The workflow ends only when the project has no connected document folder. Transcript folders keep their own workflow, which this one never touches.

### Renames, moves and edits

A file is identified by its folder and its drive item id, which Graph keeps through renames and moves within a drive. A file renamed or moved inside the connected folder keeps its context; its title and path are updated, and nothing is imported again. A file moved to another connected document folder is imported there as a new file and removed from the first folder by the removal rule below; until then both copies exist.

A file's content version is Graph's `quickXorHash` when it has one, otherwise its size and modified time. A changed file is imported again only once the same new version has been seen in two consecutive reads that list it. Its old context is removed and the new version imported; the file's own source type and AI instructions carry over. If the new version cannot be imported (too big, say), the file has no copy and shows why.

### Removal

A file missing from two consecutive complete listings is looked up by id. It is removed when Graph answers 404 (deleted, or in the recycle bin), or when it now lies outside the folder or more than 5 levels below it; placement is found by walking up parent ids, not by comparing paths. A file the lookup finds still inside has its miss count reset.

Removal is a tombstone first. The row saves the context's own source type and AI instructions, then the workflow deletes the context through `contextDeletionWorkflow` as a child with the id `document-folder-context-deletion-{contextId}`. A follow-up activity then deletes the context's vectors in strict mode, confirms the context row is gone, deletes the stored copy and releases the row. A deletion that did not finish leaves the row holding its context, and the next pass drives it again. A removed file that comes back, for example restored from the recycle bin, returns once its old context is gone; its saved guidance applies when it is imported again.

### Removals that wait

A read that cannot settle what left the folder removes nothing, and the folder shows why removals are paused:

| Code | Cause |
|---|---|
| `TOO_LARGE` | The read reached the 5,000-item scan cap. |
| `THROTTLED` | Graph throttled a page of the listing, or the removal lookups. |
| `PARTIAL_READ` | Graph refused a page of the listing for another reason. |
| `MASS_REMOVAL` | The files confirmed gone are at least 10 and more than 20% of the folder's files. |

A partial read still records new files, renames and new versions, but it moves nothing out of the import window and counts no misses. A file new to a full window waits outside it until a complete read. The next complete read clears the first three codes.

A mass removal is held, not dropped: the folder shows how many files wait, and an editor confirms with **Confirm removal**. Confirming removes exactly the held files still missing from two complete listings; a file seen again in the meantime leaves the hold. A lookup cut short by throttling acts on none of its files, because acting on part of them could remove a share of the folder that, counted whole, would have been held.

### Problems

A problem shows on the folder and never counts as a listing, so it removes nothing. Every pass tries the folder again, and the first read that gets through clears the problem:

| Code | Cause |
|---|---|
| `RECONNECT` | The reader's Microsoft connection is gone, or Graph answered 401. |
| `NO_ACCESS` | Graph answered 403 on the folder, the reader can no longer add context to the project, or the project's organization is not the folder's. |
| `FOLDER_GONE` | Graph answered 404 on the folder itself. |
| `SYNC_START_FAILED` | Connecting or reconnecting could not start the sync, so no pass may be coming. Sync now or Reconnect starts it. |

The UI renders every problem, paused reason and skip reason from these fixed codes, never from Graph's error text, which is neither stored nor logged.

### Files removed by hand

Deleting an imported file's context on the Context tab makes it an exclusion: the next read marks the file excluded, even if that read did not reach the file, and it is not imported again until its content changes at the source. This holds after the file is removed at the source and later restored. While the file's folder is connected, the delete confirmation says so; a file from a disconnected folder is ordinary context and gets the plain warning.

## Reconnect and disconnect

**Reconnect** makes the person reconnecting the reader of the folder, of its file rows and of the contexts those rows hold, so deleting the previous reader's account cannot cascade away contexts the folder still tracks. It raises a reader epoch, so a read still running as the previous reader applies nothing, and it resets miss counts, which were counted from the previous reader's view. Files whose download had failed are offered again.

Deleting the reader's account cascades to the folder rows, the file rows and the imported contexts; after any reconnect the reader owns all three, so they go together. A file the reader can no longer see drops out of the listing; when its lookup answers 404 it is removed like a deleted one, and it is imported again, with its saved guidance, once it is visible again. A loss at the scale of a mass removal is held instead.

**Disconnect** stops reading the folder. Every imported file stays as ordinary project context, the folder's description no longer applies to them, and no pending deletion of a disconnected folder's file is driven. Connecting the same folder again reconnects it, with its earlier files.

## Who sees what

Imported files become ordinary project context, visible to every member and guest who can read the project's context, whatever their permissions in OneDrive or SharePoint. The picker says so before anything is connected.

The folder list answers per caller. An editor gets each folder's reader, drive, item and site ids, web address and the files that need attention. A viewer or guest gets the place (provider, site, library, name and path), the description, the counts and the state, never the reader, those identifiers or the web address. The imported contexts' own metadata, which any reader of the project's context receives, holds the folder id, the drive item id and the path below the folder.

## Folder description as source guidance

The description lives only on the folder row, stored as one line without control characters and cut at 500 characters. It is never copied onto the files and never embedded: model-facing readers add it at read time, so an edit takes effect on the next retrieval without re-importing anything, and a disconnect ends it.

`folder-guidance.ts` adds it to hydrated rows whose `metadata.provider` names a document folder and whose folder is still connected, with one indexed lookup on the file ledger's `contextId` per batch, scoped to the project. A file's own guidance wins, then a crawled page's parent guidance, then the folder description. The inherited text passes through `neutralizeAiChatAttachmentBody`, as company context does, and has any `project_context` tag defused, because guidance is rendered inside that block. Per-row guidance set on the Context tab is still rendered as written.

The readers that apply it are `getRetrievableContextById`, semantic search hydration (`packages/rag/lib/project-contexts/search-hits.ts`), spec retrieval (`retrieve-for-spec.ts`), the internal agent execution context route, and the MCP project context tools, which report it as `inheritedSourceGuidance` beside the row's own value.

## Microsoft Graph notes

- **Delta is not used.** On OneDrive for Business, `delta` works on a drive's root only, not on a folder inside it. Microsoft does not document how items moved out of a folder appear in a folder's delta, and the delta link arrives only on the last page, which conflicts with the scan cap. Each read therefore lists the tree with `/children` (200 items a page), and removal rests on complete listings plus a lookup by id.
- **`/children` can miss items while the folder is being written to.** Microsoft documents this risk. Requiring two complete listings and a lookup before removing anything covers it, even when two reads run seconds apart.
- **Throttling.** The Graph request helper retries 429 and 503 (and 500, 502 and 504 on reads) up to three times, following `Retry-After` but waiting at most 15 seconds each time. A 429 or 503 that outlasts those retries ends that folder's read as incomplete, and the folder is not read again before the time Graph gave, or 5 minutes when it gave none. The read activity heartbeats after every Graph request.
- **Shared items.** Files shared from other drives (`sharedWithMe`, `remoteItem`) are not browsable, and Microsoft is retiring `sharedWithMe`.
- **SharePoint discovery.** Microsoft documents `/me/followedSites` as sometimes wrong, so followed sites are a convenience: a failure other than a 4xx lists none rather than failing the picker.

## Rollout

The feature is behind one org-scopable flag, `CLOUD_DRIVE_FOLDERS` (`FABRIC_FEATURE_CLOUD_DRIVE_FOLDERS`, default off). It gates the Context tab entry points and their Get Started copy, the document folder procedures (which answer NOT_FOUND while it is off), and the sync. With it off, the sync's listing activity reports that nothing is due, so the workflow waits rather than ends, and reads resume within 30 minutes of turning it back on without anyone connecting or syncing. Connected folders and imported files are kept. Workflow code never reads the flag; API code and activities do. Transcript folders are unaffected.

**Deploy order:**

1. The migration and RLS run before any pod rolls. The flag does not make this optional: the transcript-folder connect reads the document-folder table whatever the flag says.
2. Roll out the web deployment and the Temporal worker, and wait until a worker that registers `documentFolderSyncWorkflow` is live.
3. Only then enable `CLOUD_DRIVE_FOLDERS` for an organization through the admin organization override (`admin.featureFlags.setForOrg`), so the web tier and the worker read the same value.
