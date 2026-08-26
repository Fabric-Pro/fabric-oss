"use client";

import { Spinner } from "@shared/components/Spinner";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { SearchInput } from "@ui/components/search-input";
import { ExternalLinkIcon, SearchIcon, ServerIcon } from "lucide-react";
import { useState } from "react";
import { useDebounceValue } from "usehooks-ts";
import { McpServerCard } from "../../../saas/mcp/components/McpServerCard";

interface McpServer {
	id: string;
	key: string;
	name: string;
	description: string | null;
	docsUrl: string | null;
	iconUrl: string | null;
	author: string | null;
	repositoryUrl: string | null;
	category: string | null;
	tags: string[];
	authMethods: string[];
}

export function PublicMcpRegistryView() {
	const [searchQuery, setSearchQuery] = useState("");
	const [debouncedSearch] = useDebounceValue(searchQuery, 300);
	const [selectedCategory, setSelectedCategory] = useState<string | null>(
		null,
	);

	// Fetch public MCP servers
	const { data: servers = [], isLoading } = useQuery({
		queryKey: ["mcp-public-registry"],
		queryFn: async () => {
			const result = await orpcClient.mcp.publicRegistry.list();
			return result as McpServer[];
		},
	});

	// Get unique categories
	const categories = Array.from(
		new Set(servers.map((s) => s.category).filter(Boolean)),
	) as string[];

	// Filter servers
	const filteredServers = servers.filter((server) => {
		const matchesSearch =
			!debouncedSearch ||
			server.name.toLowerCase().includes(debouncedSearch.toLowerCase()) ||
			server.description
				?.toLowerCase()
				.includes(debouncedSearch.toLowerCase()) ||
			server.author
				?.toLowerCase()
				.includes(debouncedSearch.toLowerCase());

		const matchesCategory =
			!selectedCategory || server.category === selectedCategory;

		return matchesSearch && matchesCategory;
	});

	return (
		<div className="container mx-auto px-4 pt-16 pb-12">
			{/* Header */}
			<div className="text-center mb-12">
				<div className="flex items-center justify-center gap-3 mb-4">
					<ServerIcon className="size-10 text-primary" />
					<h1 className="text-4xl font-bold">MCP Server Registry</h1>
				</div>
				<p className="text-lg text-muted-foreground max-w-2xl mx-auto">
					Discover and explore Model Context Protocol (MCP) servers.
					Connect your AI applications to powerful tools and data
					sources.
				</p>
				<div className="flex items-center justify-center gap-2 mt-4">
					<Badge variant="secondary" className="text-sm">
						{servers.length} servers available
					</Badge>
					<a
						href="https://github.com/modelcontextprotocol"
						target="_blank"
						rel="noopener noreferrer"
						className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-primary transition-colors"
					>
						<ExternalLinkIcon className="size-4" />
						Learn about MCP
					</a>
				</div>
			</div>

			{/* Search and Filters */}
			<div className="flex flex-col sm:flex-row items-center gap-4 mb-8">
				<div className="relative flex-1 w-full max-w-md">
					<SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
					<SearchInput
						placeholder="Search MCP servers..."
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						className="pl-9"
					/>
				</div>
				{categories.length > 0 && (
					<div className="flex flex-wrap gap-2">
						<Badge
							variant={
								selectedCategory === null
									? "default"
									: "outline"
							}
							className="cursor-pointer"
							onClick={() => setSelectedCategory(null)}
						>
							All
						</Badge>
						{categories.map((category) => (
							<Badge
								key={category}
								variant={
									selectedCategory === category
										? "default"
										: "outline"
								}
								className="cursor-pointer"
								onClick={() => setSelectedCategory(category)}
							>
								{category}
							</Badge>
						))}
					</div>
				)}
			</div>

			{/* Server Grid */}
			{isLoading ? (
				<div className="flex items-center justify-center py-20">
					<Spinner />
				</div>
			) : filteredServers.length === 0 ? (
				<div className="text-center py-20">
					<ServerIcon className="size-12 text-muted-foreground mx-auto mb-4" />
					<p className="text-muted-foreground">
						{searchQuery
							? "No MCP servers found matching your search"
							: "No MCP servers available yet"}
					</p>
				</div>
			) : (
				<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
					{filteredServers.map((server) => (
						<McpServerCard
							key={server.id}
							server={server}
							showInstallButton={false}
							isPublic={true}
						/>
					))}
				</div>
			)}
		</div>
	);
}
