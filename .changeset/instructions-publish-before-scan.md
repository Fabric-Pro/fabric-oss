---
"fabric-app": patch
---

Members who can publish coding instructions can now choose to publish an upload or an added file immediately and have its secret scan run afterwards, with the scan's findings shown on the Coding Instructions page.

The option sits under "Publish as soon as the upload passes checks" in the upload dialog and the add-file dialog, and needs the publish permission as well as the upload one. Before submitting, the member confirms that until the scan finishes a secret in the files may be visible to project members and synced to their machines by the CLI. The integrity checks still run first: a credential file name, a missing or changed file, or a `.fabricignore` that does not match the rules applied still rejects the version before anything is published. The content scan then reads the stored copy of the published version. Nothing is withdrawn automatically: possible secrets are shown on the published view and in History with the same file table as a rejected upload, and the member publishes a fixed or earlier version. A scan that cannot finish is shown as not checked rather than as passed, and History will not publish such a version again until its scan has passed. Three audit actions record the publication and any unclean verdict.
