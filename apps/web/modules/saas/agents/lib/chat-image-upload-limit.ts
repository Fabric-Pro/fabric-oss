/**
 * Largest image `/api/agents/fabric-ai/upload-image` accepts. The hosting
 * platform refuses a request body above ~4.5 MB before the route runs, with
 * a 413 that is not JSON; the route used to allow 10 MB, so an image between
 * the two failed with nothing but "Failed to upload" (review F37). Anything
 * shaped by `prepareImageForAi` (≤ ~3.75 MB) fits.
 *
 * Its own module so the route can import it without the client-side image
 * pipeline.
 */
export const CHAT_IMAGE_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
