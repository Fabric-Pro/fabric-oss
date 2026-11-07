/** Pure shared contracts: safe to load outside the Temporal workflow sandbox. */
import { DELIVERY_SOURCE_CAPTURE_PAGE_SIZE } from "@repo/connectors/delivery-source-capture-limits";

export {
	DELIVERY_SOURCE_CAPTURE_MAX_CIPHERTEXT_CHARS,
	DELIVERY_SOURCE_CAPTURE_MAX_SNAPSHOT_BYTES,
	DELIVERY_SOURCE_CAPTURE_MAX_TEXT_BYTES,
	DELIVERY_SOURCE_CAPTURE_PAGE_SIZE,
} from "@repo/connectors/delivery-source-capture-limits";

export const DELIVERY_SOURCE_CAPTURE_TASK_QUEUE = "fabric-worker";
export const DELIVERY_SOURCE_ADAPTER_VERSION = "slack-private-roots-v1";
export const DELIVERY_SOURCE_CAPTURE_MAX_PAGES = 5;
export const DELIVERY_SOURCE_CAPTURE_MAX_CAPTURED =
	DELIVERY_SOURCE_CAPTURE_MAX_PAGES * DELIVERY_SOURCE_CAPTURE_PAGE_SIZE;
export const DELIVERY_SOURCE_CAPTURE_ADMISSION_WINDOW_MS = 10 * 60_000;
export const DELIVERY_SOURCE_CAPTURE_MIN_RETENTION_MS = 60 * 60_000;
export const DELIVERY_SOURCE_CAPTURE_EXECUTION_TIMEOUT_MS = 15 * 60_000;

/** Only identities and configuration revisions enter durable workflow history. */
export interface DeliverySourceCaptureInput {
	organizationId: string;
	userId: string;
	projectId: string;
	watchId: string;
	grantRevision: number;
	configVersion: number;
	mode: "RECENT" | "CONTINUE" | "BACKFILL";
	window?: { start: string; end: string };
}

/** Source content and credentials never cross an activity result boundary. */
export interface DeliverySourceCaptureResult {
	captured: number;
	hasMore: boolean;
	coverage: "ROOT_MESSAGES_ONLY" | "PARTIAL";
}
