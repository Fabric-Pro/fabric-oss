/**
 * MCP Server List
 *
 * Displays the list of MCP servers from the registry with search and filtering.
 * Separates web-configurable servers (HTTP/SSE) from local-only servers (STDIO).
 */

import { SettingsItem } from "@saas/shared/components/SettingsItem";
import { Badge } from "@ui/components/badge";
import { SearchInput } from "@ui/components/search-input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import { GlobeIcon, SearchIcon, TerminalIcon } from "lucide-react";
import { useMemo, useState } from "react";
import type { McpServer } from "../types";
import { isServerConfigurableViaWeb } from "../types";
import { McpServerCard } from "./McpServerCard";

export interface McpServerListProps {
	servers: McpServer[];
	searchQuery: string;
	onSearchChange: (query: string) => void;
	isLoading?: boolean;
	disabled?: boolean;
	onConfigure: (server: McpServer) => void;
	onEdit?: (server: McpServer) => void;
	onDelete?: (server: McpServer) => void;
	title?: string;
	description?: string;
}

type ServerFilter = "all" | "web" | "local";

export function McpServerList({
	servers,
	searchQuery,
	onSearchChange,
	isLoading = false,
	disabled = false,
	onConfigure,
	onEdit,
	onDelete,
	title = "Available MCP Servers",
	description = "Registry of built-in MCP servers. Configure to use.",
}: McpServerListProps) {
	const [activeFilter, setActiveFilter] = useState<ServerFilter>("web");

	// Managed-default servers (any with `defaultEnabled = true`) are
	// auto-installed for every tenant and surfaced in the configurations
	// list with the "Always on" pill. Hide them from the registry add-list
	// here so users don't see an entry for something they can't install or
	// reconfigure. Generalizes to every future default-enabled MCP.
	const visibleServers = useMemo(
		() => servers.filter((s) => !s.defaultEnabled),
		[servers],
	);

	// Separate servers by configurability
	const { webServers, localServers } = useMemo(() => {
		const web: McpServer[] = [];
		const local: McpServer[] = [];
		for (const server of visibleServers) {
			if (isServerConfigurableViaWeb(server)) {
				web.push(server);
			} else {
				local.push(server);
			}
		}
		return { webServers: web, localServers: local };
	}, [visibleServers]);

	// Filter servers based on search query and active filter
	const filteredServers = useMemo(() => {
		let serversToFilter: McpServer[];
		switch (activeFilter) {
			case "web":
				serversToFilter = webServers;
				break;
			case "local":
				serversToFilter = localServers;
				break;
			default:
				serversToFilter = visibleServers;
		}

		if (!searchQuery.trim()) {
			return serversToFilter;
		}
		const query = searchQuery.toLowerCase();
		return serversToFilter.filter(
			(server) =>
				server.name?.toLowerCase().includes(query) ||
				server.key?.toLowerCase().includes(query) ||
				server.defaultUrl?.toLowerCase().includes(query) ||
				server.command?.toLowerCase().includes(query) ||
				server.description?.toLowerCase().includes(query),
		);
	}, [visibleServers, webServers, localServers, searchQuery, activeFilter]);

	return (
		<SettingsItem title={title} description={description}>
			<div className="space-y-3">
				{/* Search Bar */}
				<div className="relative">
					<SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
					<SearchInput
						placeholder="Search MCP servers..."
						value={searchQuery}
						onChange={(e) => onSearchChange(e.target.value)}
						className="pl-9"
					/>
				</div>

				{/* Filter Tabs */}
				<Tabs
					value={activeFilter}
					onValueChange={(v) => setActiveFilter(v as ServerFilter)}
				>
					<TabsList className="grid w-full grid-cols-3">
						<TabsTrigger
							value="web"
							className="flex items-center gap-1.5"
						>
							<GlobeIcon className="size-3.5" />
							<span>Remote</span>
							<Badge
								variant="secondary"
								className="ml-1 px-1.5 py-0 text-[10px]"
							>
								{webServers.length}
							</Badge>
						</TabsTrigger>
						<TabsTrigger
							value="local"
							className="flex items-center gap-1.5"
						>
							<TerminalIcon className="size-3.5" />
							<span>Local</span>
							<Badge
								variant="secondary"
								className="ml-1 px-1.5 py-0 text-[10px]"
							>
								{localServers.length}
							</Badge>
						</TabsTrigger>
						<TabsTrigger value="all">
							All
							<Badge
								variant="secondary"
								className="ml-1 px-1.5 py-0 text-[10px]"
							>
								{servers.length}
							</Badge>
						</TabsTrigger>
					</TabsList>

					{/* Info text for local tab */}
					{activeFilter === "local" && (
						<p className="text-xs text-muted-foreground mt-2 p-2 bg-highlight/5 rounded-sm border border-highlight/20">
							Local servers run via command line (npx/uvx) and
							require Claude Desktop or a local MCP client. They
							cannot be configured from the web UI.
						</p>
					)}

					<TabsContent value={activeFilter} className="mt-3">
						{/* Server List */}
						{isLoading && (
							<div className="text-sm text-muted-foreground">
								Loading registry...
							</div>
						)}
						{!isLoading && servers.length === 0 && (
							<div className="text-sm text-muted-foreground">
								No servers in registry.
							</div>
						)}
						{!isLoading &&
							servers.length > 0 &&
							filteredServers.length === 0 && (
								<div className="text-sm text-muted-foreground">
									No servers found matching "{searchQuery}"
								</div>
							)}
						{!isLoading && filteredServers.length > 0 && (
							<div className="max-h-[480px] overflow-y-auto space-y-2 pr-1">
								{filteredServers.map((server) => (
									<McpServerCard
										key={server.id}
										server={server}
										disabled={disabled}
										onConfigure={onConfigure}
										onEdit={onEdit}
										onDelete={onDelete}
									/>
								))}
							</div>
						)}
					</TabsContent>
				</Tabs>
			</div>
		</SettingsItem>
	);
}
