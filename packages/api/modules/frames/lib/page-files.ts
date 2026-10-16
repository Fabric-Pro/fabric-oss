import { config } from "@repo/config";

/**
 * Where the files a published page stored live. Uploads and deletes must use
 * the same bucket and the keys `buildFramePageFilePath` makes, or a deleted
 * page leaves its files behind.
 */
export const PAGE_FILES_BUCKET = config.storage.bucketNames.workspaceDocuments;
