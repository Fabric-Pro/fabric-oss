import type { FabricHttpClient } from "../client.js";
import type { FabricFrame, ListOptions } from "../types.js";

export interface ListFramesOptions extends ListOptions {
	status?: string;
	conversationId?: string;
}

export interface FrameContentEdit {
	expectedUpdatedAt: string;
	title?: string;
	description?: string;
	blocks?: Array<{
		id: string;
		type: "html" | "json" | "mermaid" | "markdown";
		content: string;
		title?: string;
		language?: string;
	}>;
	theme?: { mode?: "light" | "dark" | "system"; accentColor?: string };
}
export interface FrameVersionEntry {
	id: string;
	editType: string;
	editedAt: string;
	canRestore: boolean;
	revertedToVersion: number | null;
}

export interface FrameExportInput {
	expectedUpdatedAt: string;
	requestId: string;
	orientation?: "portrait" | "landscape";
}
export interface FrameExportStatus {
	exportId: string;
	status:
		| "pending"
		| "running"
		| "completed"
		| "failed"
		| "cancelled"
		| "expired";
	expectedUpdatedAt: string;
	expiresAt?: string;
	error?: string;
}
export interface FrameShareInput {
	expectedUpdatedAt: string;
	scope: "PRIVATE" | "PUBLIC" | "EMAILS_ONLY" | "WORKSPACE_AND_EMAILS";
	emails?: string[];
}
export interface FrameRevokeSharingInput {
	expectedUpdatedAt: string;
	mode: "public-link" | "invitation" | "all";
	email?: string;
}
export interface FrameSharingState {
	scope: string;
	hasPublicLink: boolean;
	updatedAt: string;
	grants: Array<{ id: string; email: string | null; invitedAt: string }>;
}
export interface FrameSharingResult {
	ok: true;
	scope: string;
	updatedAt: string;
	shareToken?: string;
	invited?: string[];
	grants?: FrameSharingState["grants"];
	revokedInvitations?: number;
}

export class FramesResource {
	constructor(private readonly http: FabricHttpClient) {}

	startExport(
		id: string,
		input: FrameExportInput,
		options: { org?: string } = {},
	) {
		return this.http.post<FrameExportStatus>(
			`/frames/${encodeURIComponent(id)}/exports${buildQuery(options)}`,
			input,
			{ retry: { maxRetries: 0 } },
		);
	}
	getExport(id: string, exportId: string, options: { org?: string } = {}) {
		return this.http.get<FrameExportStatus>(
			`/frames/${encodeURIComponent(id)}/exports/${encodeURIComponent(exportId)}${buildQuery(options)}`,
		);
	}
	cancelExport(id: string, exportId: string, options: { org?: string } = {}) {
		return this.http.post<FrameExportStatus>(
			`/frames/${encodeURIComponent(id)}/exports/${encodeURIComponent(exportId)}/cancel${buildQuery(options)}`,
			{},
			{ retry: { maxRetries: 0 } },
		);
	}
	downloadExport(
		id: string,
		exportId: string,
		options: { org?: string } = {},
	) {
		return this.http.post<{ url: string; expiresAt: string }>(
			`/frames/${encodeURIComponent(id)}/exports/${encodeURIComponent(exportId)}/download${buildQuery(options)}`,
			{},
			{ retry: { maxRetries: 0 } },
		);
	}
	sharing(id: string, options: { org?: string } = {}) {
		return this.http.get<FrameSharingState>(
			`/frames/${encodeURIComponent(id)}/sharing${buildQuery(options)}`,
		);
	}
	share(id: string, input: FrameShareInput, options: { org?: string } = {}) {
		return this.http.post<FrameSharingResult>(
			`/frames/${encodeURIComponent(id)}/share${buildQuery(options)}`,
			input,
			{ retry: { maxRetries: 0 } },
		);
	}
	revokeSharing(
		id: string,
		input: FrameRevokeSharingInput,
		options: { org?: string } = {},
	) {
		return this.http.post<FrameSharingResult>(
			`/frames/${encodeURIComponent(id)}/revoke-sharing${buildQuery(options)}`,
			input,
			{ retry: { maxRetries: 0 } },
		);
	}

	history(id: string, options: { org?: string } = {}) {
		return this.http.get<{
			updatedAt: string;
			history: FrameVersionEntry[];
		}>(`/frames/${encodeURIComponent(id)}/history${buildQuery(options)}`);
	}
	update(id: string, edit: FrameContentEdit, options: { org?: string } = {}) {
		return this.http.post<FabricFrame>(
			`/frames/${encodeURIComponent(id)}/update${buildQuery(options)}`,
			edit,
			{ retry: { maxRetries: 0 } },
		);
	}
	restore(
		id: string,
		restore: {
			expectedUpdatedAt: string;
			historyEntryId?: string;
			toVersion?: number;
		},
		options: { org?: string } = {},
	) {
		return this.http.post<{ success: boolean; updatedAt: string }>(
			`/frames/${encodeURIComponent(id)}/restore${buildQuery(options)}`,
			restore,
			{ retry: { maxRetries: 0 } },
		);
	}

	list(options: ListFramesOptions = {}): Promise<FabricFrame[]> {
		const q = buildQuery(options);
		return this.http.get<FabricFrame[]>(`/frames${q}`);
	}

	get(
		id: string,
		options: { org?: string; personal?: boolean } = {},
	): Promise<FabricFrame> {
		const params = new URLSearchParams();
		if (options.org) {
			params.set("org", options.org);
		}
		if (options.personal) {
			params.set("personal", "1");
		}
		const q = params.toString() ? `?${params.toString()}` : "";
		return this.http.get<FabricFrame>(
			`/frames/${encodeURIComponent(id)}${q}`,
		);
	}
}

function buildQuery(opts: object): string {
	const params = new URLSearchParams();
	for (const [k, v] of Object.entries(opts)) {
		if (v !== undefined && v !== null) {
			params.set(k, k === "personal" ? (v ? "1" : "") : String(v));
		}
	}
	const s = params.toString();
	return s ? `?${s}` : "";
}
