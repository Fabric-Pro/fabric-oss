import type { FabricHttpClient } from "../client.js";
import { FabricError, type FabricSkill, type ListOptions } from "../types.js";
export type SkillCatalogTab =
	| "organization"
	| "builtin"
	| "drafts"
	| "archived"
	| "all";
export interface ListSkillsOptions extends ListOptions {
	tab?: SkillCatalogTab;
	category?: string;
	cursor?: string;
	scope?: "SYSTEM" | "ORGANIZATION";
	tags?: string[];
	isPublished?: boolean;
	isDiscoverable?: boolean;
	sortBy?: "name" | "createdAt" | "updatedAt" | "useCount";
	sortOrder?: "asc" | "desc";
}
export type SkillSummary = Omit<FabricSkill, "content"> & { content?: string };
export interface SkillPage {
	skills: SkillSummary[];
	total: number;
	hasMore: boolean;
	nextCursor: string | null;
}
export interface SkillContextOptions {
	org?: string;
}
export interface SkillCreateInput {
	name: string;
	slug: string;
	description: string;
	content: string;
	category?: string;
	tags?: string[];
	isPublished?: boolean;
	isDiscoverable?: boolean;
}
export interface SkillUpdateInput {
	expectedVersion?: number;
	name?: string;
	slug?: string;
	description?: string;
	content?: string;
	category?: string | null;
	tags?: string[];
}
export interface SkillVersionInput {
	expectedVersion?: number;
}
export interface SkillPublishInput {
	expectedVersion: number;
	availability: "members" | "agents" | "draft";
}
export interface SkillAuthoringDraft {
	name: string;
	slug: string;
	description: string;
	content: string;
	category?: string;
	tags?: string[];
}
export interface SkillAssistInput {
	draft: SkillAuthoringDraft;
	message: string;
	history?: Array<{ role: "user" | "assistant"; content: string }>;
}
export interface SkillAssistResult {
	message: string;
	proposal: SkillAuthoringDraft | null;
}
export type SkillImportSource =
	| { kind: "file"; fileName: string; base64: string }
	| { kind: "github"; url: string; ref?: string };
export interface SkillImportPreviewInput {
	source: SkillImportSource;
}
export interface SkillImportCreateInput extends SkillImportPreviewInput {
	candidateKey: string;
	expectedHash: string;
	overrides?: { name?: string; slug?: string; description?: string };
}
export interface SkillImportFileReadInput {
	source: SkillImportSource;
	candidateKey: string;
	expectedHash: string;
	path: string;
}
export interface SkillFileReadInput {
	path: string;
	expectedVersion?: number;
}
export interface SkillFileContent {
	path: string;
	contentType: string;
	sizeBytes: number;
	sha256: string;
	encoding: "utf-8" | "base64";
	data: string;
}
export interface SkillImportPreview {
	source: {
		kind: "file" | "github";
		sha256: string;
		fileName?: string;
		repository?: string;
		commit?: string;
	};
	candidates: Array<{
		key: string;
		draft: SkillAuthoringDraft;
		files: Array<{
			path: string;
			contentType: string;
			sizeBytes: number;
			sha256: string;
		}>;
		warnings: string[];
	}>;
	warnings: string[];
}
export type SkillPolicyAudience = "permitted_members" | "administrators";
export interface SkillGovernancePolicy {
	create: SkillPolicyAudience;
	publish: SkillPolicyAudience;
	discover: SkillPolicyAudience;
}
export interface SkillGovernance {
	policy: SkillGovernancePolicy;
	revision: number;
	canManage: boolean;
	capabilities: {
		canCreate: boolean;
		canPublish: boolean;
		canDiscover: boolean;
	};
}
export interface SkillGovernanceUpdateInput {
	expectedRevision: number;
	policy: SkillGovernancePolicy;
}
function query(options: object = {}) {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(options)) {
		if (value !== undefined && value !== null) {
			if (Array.isArray(value)) {
				for (const item of value) {
					params.append(key, String(item));
				}
			} else {
				params.set(
					key,
					key === "personal" ? (value ? "1" : "") : String(value),
				);
			}
		}
	}
	return params.size ? `?${params}` : "";
}
// A 2 MiB UTF-8 file can expand sixfold when JSON escapes control bytes.
const SKILL_FILE_RESPONSE_MAX_BYTES = 13 * 1024 * 1024;
export class SkillsResource {
	constructor(private readonly http: FabricHttpClient) {}
	/** Compatibility list. Use listPage to inspect total/cursor metadata. */
	list(options: ListSkillsOptions = {}): Promise<FabricSkill[]> {
		return this.http.get(`/skills${query(options)}`);
	}
	listPage(options: ListSkillsOptions = {}): Promise<SkillPage> {
		return this.http.get(`/skills${query({ ...options, page: 1 })}`);
	}
	get(id: string, options: SkillContextOptions = {}): Promise<FabricSkill> {
		return this.http.get(
			`/skills/${encodeURIComponent(id)}${query(options)}`,
		);
	}
	create(
		input: SkillCreateInput,
		options: SkillContextOptions = {},
	): Promise<FabricSkill> {
		return this.write("POST", `/skills${query(options)}`, input);
	}
	update(
		id: string,
		input: SkillUpdateInput,
		options: SkillContextOptions = {},
	): Promise<FabricSkill> {
		return this.write(
			"PATCH",
			`/skills/${encodeURIComponent(id)}${query(options)}`,
			input,
		);
	}
	archive(
		id: string,
		input: SkillVersionInput = {},
		options: SkillContextOptions = {},
	): Promise<FabricSkill> {
		return this.write(
			"POST",
			`/skills/${encodeURIComponent(id)}/archive${query(options)}`,
			input,
		);
	}
	restore(
		id: string,
		input: SkillVersionInput = {},
		options: SkillContextOptions = {},
	): Promise<FabricSkill> {
		return this.write(
			"POST",
			`/skills/${encodeURIComponent(id)}/restore${query(options)}`,
			input,
		);
	}
	publish(
		id: string,
		input: SkillPublishInput,
		options: SkillContextOptions = {},
	): Promise<FabricSkill> {
		return this.write(
			"POST",
			`/skills/${encodeURIComponent(id)}/publish${query(options)}`,
			input,
		);
	}
	/** Explicit permanent delete, independently authorized by the current owner role. */
	delete(
		id: string,
		options: SkillContextOptions & { expectedVersion?: number } = {},
	): Promise<{ success: true }> {
		return this.write(
			"DELETE",
			`/skills/${encodeURIComponent(id)}${query(options)}`,
			undefined,
		);
	}
	assist(
		input: SkillAssistInput,
		options: SkillContextOptions = {},
	): Promise<SkillAssistResult> {
		return this.write(
			"POST",
			`/skill-assistance${query(options)}`,
			input,
			128 * 1024,
		);
	}
	previewImport(
		input: SkillImportPreviewInput,
		options: SkillContextOptions = {},
	): Promise<SkillImportPreview> {
		return this.write(
			"POST",
			`/skill-imports/preview${query(options)}`,
			input,
			12 * 1024 * 1024,
		);
	}
	createImport(
		input: SkillImportCreateInput,
		options: SkillContextOptions = {},
	): Promise<FabricSkill> {
		return this.write(
			"POST",
			`/skill-imports${query(options)}`,
			input,
			12 * 1024 * 1024,
		);
	}
	readFile(
		id: string,
		input: SkillFileReadInput,
		options: SkillContextOptions = {},
	): Promise<SkillFileContent> {
		return this.http.request(
			"GET",
			`/skills/${encodeURIComponent(id)}/files${query({ ...input, ...options })}`,
			{
				boundedRead: {
					maxResponseBytes: SKILL_FILE_RESPONSE_MAX_BYTES,
				},
			},
		);
	}
	readImportFile(
		input: SkillImportFileReadInput,
		options: SkillContextOptions = {},
	): Promise<SkillFileContent> {
		if (
			new TextEncoder().encode(JSON.stringify(input)).byteLength >
			12 * 1024 * 1024
		) {
			return Promise.reject(
				new FabricError(
					"Skill import request exceeds the allowed size.",
					0,
					"INVALID_REQUEST",
				),
			);
		}
		return this.http.request(
			"POST",
			`/skill-imports/file${query(options)}`,
			{
				body: input,
				retry: { maxRetries: 0 },
				boundedRead: {
					maxResponseBytes: SKILL_FILE_RESPONSE_MAX_BYTES,
				},
			},
		);
	}
	getGovernance(options: SkillContextOptions = {}): Promise<SkillGovernance> {
		return this.http.get(`/skill-governance${query(options)}`);
	}
	updateGovernance(
		input: SkillGovernanceUpdateInput,
		options: SkillContextOptions = {},
	): Promise<SkillGovernance> {
		return this.write("PATCH", `/skill-governance${query(options)}`, input);
	}
	private write<T>(
		method: "POST" | "PATCH" | "DELETE",
		path: string,
		body: unknown,
		maxBytes = 1024 * 1024,
	): Promise<T> {
		if (
			body !== undefined &&
			new TextEncoder().encode(JSON.stringify(body)).byteLength > maxBytes
		) {
			return Promise.reject(
				new FabricError(
					"Skill request exceeds the allowed size.",
					0,
					"INVALID_REQUEST",
				),
			);
		}
		return this.http.request(method, path, {
			...(body === undefined ? {} : { body }),
			retry: { maxRetries: 0 },
		});
	}
}
