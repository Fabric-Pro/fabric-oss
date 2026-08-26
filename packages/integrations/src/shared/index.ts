/**
 * `@repo/integrations/shared` barrel — re-exports the chat-thread
 * image-attachment types and constants from a single subpath so consumers
 * can `import { MAX_BYTES_PER_IMAGE, type PendingAttachmentRef } from "@repo/integrations/shared"`
 * without dragging in the (heavier) `@repo/integrations` root that pulls in
 * `sharp`, Slack/Microsoft runtime helpers, etc.
 */

export * from "./attachment-constants";
export * from "./attachment-types";
