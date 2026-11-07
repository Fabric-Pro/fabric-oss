import type { FabricHttpClient } from "../client.js";
import type { FabricFrame, ListOptions } from "../types.js";

export interface ListFramesOptions extends ListOptions {
	status?: string;
	conversationId?: string;
}

export interface FrameContentEdit {
	presentation?: "DOCUMENT" | "INTERFACE";
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

export interface FrameAuthoringDocument {
	title: string;
	description?: string;
	kind?: "frame" | "slideshow";
	presentation?: "DOCUMENT" | "INTERFACE";
	blocks: NonNullable<FrameContentEdit["blocks"]>;
	theme?: FrameContentEdit["theme"];
}
export interface FrameDetail extends FabricFrame {
	document: FrameAuthoringDocument;
	projectId?: string | null;
	isPublishedSnapshot?: boolean;
}
export interface FrameCreateInput extends FrameAuthoringDocument {
	requestId: string;
	projectId?: string;
	conversationId?: string;
}
export interface FrameTemplateVariable {
	type: "string" | "number" | "boolean" | "select";
	label: string;
	default?: string | number | boolean;
	required?: boolean;
	options?: string[];
}
export interface FrameTemplateInput {
	requestId: string;
	name: string;
	description?: string;
	category: string;
	content: FrameAuthoringDocument;
	variables?: Record<string, FrameTemplateVariable>;
	confirmOrganizationAudience: true;
}
export interface FrameFromTemplateInput {
	requestId: string;
	templateId: string;
	variables?: Record<string, string | number | boolean>;
	title?: string;
	description?: string;
	projectId?: string;
	conversationId?: string;
}
export interface FrameTemplate {
	id: string;
	name: string;
	description?: string | null;
	category: string;
	content: FrameAuthoringDocument;
	variables: Record<string, FrameTemplateVariable>;
	isSystem: boolean;
	createdAt: string;
	updatedAt: string;
}
export interface FrameChangeProposal {
	id: string;
	frameId: string;
	status: "PENDING" | "APPLIED" | "DISMISSED";
	baseUpdatedAt: string;
	baseContentHash: string;
	proposedContentHash: string;
	createdAt: string;
	appliedUpdatedAt: string | null;
	currentUpdatedAt: string;
	conflicted: boolean;
	summary: {
		titleChanged: boolean;
		descriptionChanged: boolean;
		presentationChanged: boolean;
		themeChanged: boolean;
		blocks: Array<{
			id: string;
			title?: string;
			change: "added" | "removed" | "updated";
		}>;
	};
	base: Omit<FrameAuthoringDocument, "kind">;
	proposed: Omit<FrameAuthoringDocument, "kind">;
}
export interface FrameRevisionApproval {
	id: string;
	contentHash: string;
	sourceUpdatedAt: string;
	createdAt: string;
	origin: "APPROVED" | "LEGACY_PUBLICATION";
}
export interface FrameReviewState {
	frameId: string;
	currentUpdatedAt: string;
	currentContentHash: string;
	approved: FrameRevisionApproval | null;
	published: FrameRevisionApproval | null;
	hasPublicLink: boolean;
	hasUnapprovedChanges: boolean;
	hasUnpublishedChanges: boolean;
}

export class FramesResource {
	constructor(private readonly http: FabricHttpClient) {}

	create(input: FrameCreateInput, options: { org?: string } = {}) {
		return this.http.post<FabricFrame>(
			`/frames${buildQuery(options)}`,
			input,
			{ retry: { maxRetries: 0 } },
		);
	}
	validateDocument(
		input: FrameAuthoringDocument,
		options: { org?: string } = {},
	) {
		return this.http.post<{
			valid: boolean;
			canSave: boolean;
			checks: Array<{
				blockId?: string;
				status: "PASSED" | "FAILED" | "NOT_ASSESSED";
				message: string;
			}>;
		}>(`/frames/validate${buildQuery(options)}`, input, {
			retry: { maxRetries: 0 },
		});
	}
	listTemplates(
		options: {
			org?: string;
			category?: string;
			includeSystem?: boolean;
		} = {},
	) {
		return this.http.get<{
			templates: Array<Omit<FrameTemplate, "content" | "updatedAt">>;
			categories: string[];
		}>(`/frame-templates${buildQuery(options)}`);
	}
	getTemplate(id: string, options: { org?: string } = {}) {
		return this.http.get<FrameTemplate>(
			`/frame-templates/${encodeURIComponent(id)}${buildQuery(options)}`,
		);
	}
	createTemplate(input: FrameTemplateInput, options: { org?: string } = {}) {
		return this.http.post<FrameTemplate>(
			`/frame-templates${buildQuery(options)}`,
			input,
			{ retry: { maxRetries: 0 } },
		);
	}
	createFromTemplate(
		input: FrameFromTemplateInput,
		options: { org?: string } = {},
	) {
		return this.http.post<FabricFrame>(
			`/frames/from-template${buildQuery(options)}`,
			input,
			{ retry: { maxRetries: 0 } },
		);
	}
	proposeChange(
		id: string,
		input: {
			requestId: string;
			expectedUpdatedAt: string;
			edit: Omit<FrameContentEdit, "expectedUpdatedAt">;
		},
		options: { org?: string } = {},
	) {
		return this.http.post<FrameChangeProposal>(
			`/frames/${encodeURIComponent(id)}/changes${buildQuery(options)}`,
			input,
			{ retry: { maxRetries: 0 } },
		);
	}
	listChanges(
		id: string,
		options: { org?: string; limit?: number; offset?: number } = {},
	) {
		return this.http.get<{
			proposals: Array<Omit<FrameChangeProposal, "base" | "proposed">>;
			hasMore: boolean;
		}>(`/frames/${encodeURIComponent(id)}/changes${buildQuery(options)}`);
	}
	getChange(id: string, proposalId: string, options: { org?: string } = {}) {
		return this.http.get<FrameChangeProposal>(
			`/frames/${encodeURIComponent(id)}/changes/${encodeURIComponent(proposalId)}${buildQuery(options)}`,
		);
	}
	applyChange(
		id: string,
		input: { proposalId: string; expectedProposalHash: string },
		options: { org?: string } = {},
	) {
		return this.http.post<{
			proposalId: string;
			appliedUpdatedAt: string;
			currentUpdatedAt: string;
			replayed: boolean;
		}>(
			`/frames/${encodeURIComponent(id)}/changes/${encodeURIComponent(input.proposalId)}/apply${buildQuery(options)}`,
			{ expectedProposalHash: input.expectedProposalHash },
			{ retry: { maxRetries: 0 } },
		);
	}
	dismissChange(
		id: string,
		proposalId: string,
		options: { org?: string } = {},
	) {
		return this.http.post<{ proposalId: string; status: "DISMISSED" }>(
			`/frames/${encodeURIComponent(id)}/changes/${encodeURIComponent(proposalId)}/dismiss${buildQuery(options)}`,
			{},
			{ retry: { maxRetries: 0 } },
		);
	}
	review(id: string, options: { org?: string } = {}) {
		return this.http.get<FrameReviewState>(
			`/frames/${encodeURIComponent(id)}/review${buildQuery(options)}`,
		);
	}
	approveRevision(
		id: string,
		input: { expectedUpdatedAt: string; expectedContentHash: string },
		options: { org?: string } = {},
	) {
		return this.http.post<FrameReviewState>(
			`/frames/${encodeURIComponent(id)}/approve${buildQuery(options)}`,
			input,
			{ retry: { maxRetries: 0 } },
		);
	}

	branding(id: string, options: { org?: string } = {}) {
		return this.http.get<FrameBrandingChoices>(
			`/frames/${encodeURIComponent(id)}/branding${buildQuery(options)}`,
		);
	}
	applyBranding(
		id: string,
		input: {
			source: "COMPANY" | "CLIENT";
			expectedBrandVersion: number;
			expectedUpdatedAt: string;
		},
		options: { org?: string } = {},
	) {
		return this.http.post<FabricFrame>(
			`/frames/${encodeURIComponent(id)}/branding${buildQuery(options)}`,
			input,
			{ retry: { maxRetries: 0 } },
		);
	}
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
		return this.http.get<FrameDetail>(
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

export interface ArtifactBrandChoice {
	version: number;
	name: string | null;
	hasPalette: boolean;
	primaryColor: string;
	accentColors: string[];
	displayFontFamily: "Inter" | "Poppins" | "JetBrains Mono";
	bodyFontFamily: "Inter" | "Poppins" | "JetBrains Mono";
	coverStyle: "DARK" | "LIGHT" | "MINIMAL";
}
export interface ArtifactBrandChoices {
	company: ArtifactBrandChoice;
	client: ArtifactBrandChoice | null;
}
export interface FrameBrandingChoices extends ArtifactBrandChoices {
	frameUpdatedAt: string;
	projectId: string | null;
	current: Record<string, unknown> | null;
	canApply: boolean;
	blockedReason: "PUBLISHED" | "READ_ONLY" | null;
}
