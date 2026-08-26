"use client";

// Available option for connecting
export type ConnectionOption = {
	id: string;
	name: string;
	description?: string;
	isRecommended?: boolean;
	isAuthenticated?: boolean;
};

// Resource option for MCP connections
export type ResourceOption = {
	id: string;
	name: string;
	type: string;
	description?: string;
};
