export interface ConnectorCredentials {
	accessToken?: string | null;
	refreshToken?: string | null;
	apiKey?: string | null;
	domain?: string | null;
	email?: string | null;
	apiToken?: string | null;
	[key: string]: unknown;
}

export interface Resource {
	id: string;
	name: string;
	type: string;
	path?: string;
	metadata?: Record<string, unknown>;
}

export interface Document {
	id: string;
	externalId: string;
	title: string;
	content: string;
	contentHash?: string;
	metadata: Record<string, unknown>;
	sizeBytes?: number;
	textLength?: number;
}
