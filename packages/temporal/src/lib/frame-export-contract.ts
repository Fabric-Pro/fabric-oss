/** Native Frame export metadata; no content or bearer credentials in public state. */
export const FRAME_EXPORT_QUERY = "frameExportState";
export const FRAME_EXPORT_TTL_MS = 24 * 60 * 60 * 1000;
export const FRAME_EXPORT_MAX_BYTES = 2 * 1024 * 1024;
export const FRAME_EXPORT_DOWNLOAD_SECONDS = 60;
export type FrameExportStatus =
	| "pending"
	| "running"
	| "completed"
	| "failed"
	| "cancelled"
	| "expired";
export interface ManagedFrameExport {
	objectKey: string;
	expiresAt: string;
}
export interface FrameExportState {
	status: FrameExportStatus;
	storageKey?: string;
	expiresAt?: string;
}
export function isManagedFrameExportKey(key: string): boolean {
	return /^exports\/frames-managed\/[a-f0-9]{32}\/frame-export-v2-[a-f0-9]{32}-[a-f0-9-]{36}\.pdf$/.test(
		key,
	);
}
