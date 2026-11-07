export type ArtifactFontFamily = "Inter" | "Poppins" | "JetBrains Mono";
export type ArtifactCoverStyle = "DARK" | "LIGHT" | "MINIMAL";
export type ArtifactBrandSource = "COMPANY" | "CLIENT";

import type { FabricHttpClient } from "../client.js";
export interface ArtifactBrand {
	company: {
		name: string;
		primaryColor: string | null;
		accentColors: string[];
		guidance: string | null;
		website: string | null;
		displayFontFamily: string | null;
		bodyFontFamily: string | null;
		hasLogo: boolean;
		version: number;
	};
	client: {
		name: string | null;
		website: string | null;
		colors: string[];
		displayFontFamily: ArtifactFontFamily | null;
		bodyFontFamily: ArtifactFontFamily | null;
		coverStyle: ArtifactCoverStyle;
		hasLogo: boolean;
		version: number;
	} | null;
	clientVersion: number;
	missingClientFields: string[];
	guidance: string;
}
export interface CompanyBrandUpdate {
	expectedVersion: number;
	primaryColor?: string | null;
	accentColors?: string[];
	guidance?: string | null;
	website?: string | null;
}
export interface ClientBrandUpdate {
	expectedVersion: number;
	name: string | null;
	website: string | null;
	colors: string[];
	displayFontFamily?: ArtifactFontFamily | null;
	bodyFontFamily?: ArtifactFontFamily | null;
	coverStyle?: ArtifactCoverStyle;
}
export interface ProposalStyle {
	styleDirection: string | null;
	primaryColor: string | null;
	accentColors: string[];
	autoVisuals: boolean;
	brandSource: ArtifactBrandSource;
	coverStyle: ArtifactCoverStyle | null;
	updatedAt: string;
}
export interface ProposalStyleUpdate {
	expectedUpdatedAt: string | null;
	brandSource?: ArtifactBrandSource;
	coverStyle?: ArtifactCoverStyle | null;
	styleDirection?: string | null;
	primaryColor?: string | null;
	accentColors?: string[];
	autoVisuals?: boolean;
}
/** Reviewed brand text only. Uploads and website suggestions are reviewed in Portal. */
export class BrandingResource {
	constructor(private readonly http: FabricHttpClient) {}
	get(options: { org?: string; projectId?: string } = {}) {
		const project = options.projectId ?? this.http.defaults.project;
		return this.http.get<ArtifactBrand>(
			`${project ? `/projects/${encodeURIComponent(project)}/branding` : "/branding"}${this.query(options.org)}`,
		);
	}
	updateCompany(input: CompanyBrandUpdate, options: { org?: string } = {}) {
		return this.http.put<{ outcome: "applied"; version: number }>(
			`/branding/company${this.query(options.org)}`,
			input,
			{ retry: { maxRetries: 0 } },
		);
	}
	updateClient(
		projectId: string,
		input: ClientBrandUpdate,
		options: { org?: string } = {},
	) {
		return this.http.put<{
			outcome: "applied" | "conflict";
			version?: number;
		}>(
			`/projects/${encodeURIComponent(projectId)}/branding/client${this.query(options.org)}`,
			input,
			{ retry: { maxRetries: 0 } },
		);
	}
	getProposalStyle(
		projectId: string,
		documentId: string,
		options: { org?: string } = {},
	) {
		return this.http.get<ProposalStyle | null>(
			`/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(documentId)}/proposal-style${this.query(options.org)}`,
		);
	}
	updateProposalStyle(
		projectId: string,
		documentId: string,
		input: ProposalStyleUpdate,
		options: { org?: string } = {},
	) {
		return this.http.put<ProposalStyle>(
			`/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(documentId)}/proposal-style${this.query(options.org)}`,
			input,
			{ retry: { maxRetries: 0 } },
		);
	}
	private query(org?: string) {
		return org ? `?${new URLSearchParams({ org })}` : "";
	}
}
