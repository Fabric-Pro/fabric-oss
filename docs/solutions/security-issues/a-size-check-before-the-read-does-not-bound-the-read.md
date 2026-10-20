---
title: "A size check before the read does not bound the read"
date: 2026-10-16
category: security-issues
module: storage reads of user uploads (temporal proposal-export images and logos)
problem_type: security_issue
component: background_job
severity: high
symptoms:
  - "A user upload under a valid media key can be far larger than the upload procedure's stated limit"
  - "downloadFile holds the whole object in memory before any caller can check its size"
  - "A HEAD size check before the GET passes, and the object is replaced with a larger one before the read"
root_cause: missing_validation
resolution_type: code_fix
related_components: [api_procedures, storage]
tags: [upload, presigned-url, content-length, memory, streaming, storage, export, fizzy-2946]
audience: engineers reading user-uploaded objects from storage in a worker or a request
owner: Fabric platform
---

# A size check before the read does not bound the read

## Problem

The Proposal export (Fizzy #2946) reads uploaded images and brand logos from storage and drops any over 10 MB. The cap was checked on the bytes after `downloadFile` returned them, and `downloadFile` buffers the whole object first. Nothing guaranteed a stored upload was anywhere near the cap. A shared Temporal worker running two exports at a time could therefore be made to hold objects of any size, by any editor of the document.

## Symptoms

- An object under a valid `document-media/{projectId}/{documentId}/` key can be far larger than the 5 MB the upload procedure advertises. The procedure validates the size the client *claims* (`packages/api/modules/projects/procedures/documents/create-media-upload-url.ts:47`) and then signs the PUT without it (`:90-93`). The story media procedure does the same (`packages/api/modules/projects/procedures/stories/create-media-upload-url.ts:106-109`).
- `downloadFile` reads the body to a byte array before returning (`packages/storage/provider/s3/index.ts:635`), so a caller's own size check runs only after the memory is spent.
- A `getFileMetadata` (HEAD) check before the download passes for an object that is then replaced: the signed PUT is still valid (it lives for 60 seconds by default, `packages/storage/provider/s3/index.ts:186`) and can overwrite the key between the HEAD and the GET.

## What Didn't Work

- **Checking the size after the download.** It rejects the oversized image, but only once it has been read into memory. That is the very thing the cap was meant to prevent.
- **Checking the size with HEAD first.** This was the first fix in this session. It refuses an object that is already too large without fetching it, and for honest uploads it is enough. An independent review then pointed out the window between the HEAD and the GET. A still-valid signed PUT can replace the object in that window, and the GET buffers whatever is there. The reported size is a claim about the past; only the read itself can be bounded.
- **Trusting the upload limit.** The 5 MB limit lives in the procedure's input schema, a check on what the browser says it will send. The storage service never sees it. `getSignedUploadUrl` can bind Content-Length into the signature (it signs `content-length` when given `contentLength`, `packages/storage/provider/s3/index.ts:203-205`), but neither media procedure passes it.

## Solution

Read the object as a stream, count bytes as they arrive, and abandon the read the moment it passes the cap (`readStoredObjectWithin`, `packages/temporal/src/lib/proposal-export/read-stored-object.ts:22`):

```ts
const stream = await getObjectStream(location.key, { bucket: location.bucket });
const chunks: Buffer[] = [];
let total = 0;
try {
	for await (const chunk of stream) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += bytes.length;
		if (total > maxBytes) {
			throw new Error("Stored object is larger than an export reads");
		}
		chunks.push(bytes);
	}
} finally {
	stream.destroy(); // releases the connection whether the read finished or not
}
return Buffer.concat(chunks, total);
```

Both of the export's readers go through it: uploaded images (`packages/temporal/src/lib/proposal-export/extract-document-images.ts:80`) and logos (`packages/temporal/src/activities/proposal-export/load-theme-assets.ts:52`). A rejection drops that one image or logo and adds to a counted warning (`IMAGE_DROPPED` or `LOGO_UNAVAILABLE`); the export goes on.

## Why This Works

The bound is enforced where the bytes are, during the read, so no earlier claim about the object has to be true. At most the cap plus one stream chunk is ever held, whatever the object's size, whenever it was written and whatever any HEAD said. Destroying the stream on the way out also closes the HTTP connection, so an abandoned read does not keep downloading in the background.

## Prevention

- Treat any object a user can write as unbounded until it is read with a cap. Code that reads user uploads with `downloadFile` holds the whole object first. Prefer `getObjectStream` with a running byte count, as above, wherever a size limit matters. About two dozen non-test files call `downloadFile` as of this branch's base; not all read user uploads, and they were not audited in this session.
- Do not use a HEAD or a stored size as the bound. Use it, if at all, only as an early refusal ahead of the bounded read.
- Fix the source too: passing the declared size as `contentLength` to `getSignedUploadUrl` makes storage refuse a PUT of any other size. As of this writing neither media upload procedure does; that change is outside the export and still open. It narrows the problem but does not remove the need for bounded reads of objects already stored.
- Test the bound with a producer that never ends. `packages/temporal/src/lib/proposal-export/__tests__/read-stored-object.test.ts` ("abandons an object past the cap without reading the rest of it") feeds an endless stream and asserts the read rejects after a handful of chunks and the stream is destroyed. A test with a merely large buffer cannot tell a bounded read from one that buffers everything first.

## Related Issues

- `docs/solutions/security-issues/a-rule-for-raw-html-misses-the-html-the-parser-read-as-text.md`: the other learning from the same export work (how a stored image tag leaks a signed URL).
- `docs/solutions/security-issues/a-guard-belongs-on-the-copy-that-gets-read.md`: a guard placed where the data is checked rather than where it is read.
- Fizzy #2946 (Proposal artifact, server-side export). Fixed on branch `feature/2946-export-server`; the PR had not been opened as of this writing.
