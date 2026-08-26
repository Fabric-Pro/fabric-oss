"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { Spinner } from "@shared/components/Spinner";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Avatar, AvatarFallback, AvatarImage } from "@ui/components/avatar";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ui/components/card";
import { SearchInput } from "@ui/components/search-input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { PlusIcon, SearchIcon, TrashIcon, UserIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useDebounceValue } from "usehooks-ts";

interface WorkspaceMembersPanelProps {
	workspaceId: string;
}

type WorkspaceGroup = "administrators" | "contributors" | "stakeholders";

const _GROUP_LABELS: Record<WorkspaceGroup, string> = {
	administrators: "Administrator",
	contributors: "Contributor",
	stakeholders: "Stakeholder",
};

const GROUP_DESCRIPTIONS: Record<WorkspaceGroup, string> = {
	administrators: "Full access: manage members, settings, and documents",
	contributors: "Can upload and manage documents, but cannot manage members",
	stakeholders: "View-only access to documents",
};

export function WorkspaceMembersPanel({
	workspaceId,
}: WorkspaceMembersPanelProps) {
	const { organizationId } = useOrganizationContext();
	const [searchQuery, setSearchQuery] = useState("");
	const [debouncedSearch] = useDebounceValue(searchQuery, 300);
	const [selectedGroup, setSelectedGroup] =
		useState<WorkspaceGroup>("contributors");

	// Fetch members
	const {
		data: members,
		isLoading,
		refetch,
	} = useQuery(
		orpc.documentWorkspaces.members.list.queryOptions({
			input: { workspaceId, organizationId },
		}),
	);

	// Search users - only run when there's a search query
	const { data: searchResults, isLoading: isSearching } = useQuery({
		...orpc.documentWorkspaces.members.searchUsers.queryOptions({
			input: {
				workspaceId,
				query: debouncedSearch || "",
				limit: 10,
				organizationId,
			},
		}),
		enabled: debouncedSearch.length > 0,
	});

	// Add member mutation
	const addMemberMutation = useMutation({
		mutationFn: async ({
			userId,
			group,
		}: {
			userId: string;
			group: WorkspaceGroup;
		}) => {
			return orpc.documentWorkspaces.members.add.call({
				workspaceId,
				userId,
				group,
			});
		},
		onSuccess: () => {
			toast.success("Member added");
			refetch();
			setSearchQuery("");
		},
		onError: (error) => {
			toast.error(error.message || "Failed to add member");
		},
	});

	// Remove member mutation
	const removeMemberMutation = useMutation({
		mutationFn: async (userId: string) => {
			return orpc.documentWorkspaces.members.remove.call({
				workspaceId,
				userId,
			});
		},
		onSuccess: () => {
			toast.success("Member removed");
			refetch();
		},
		onError: (error) => {
			toast.error(error.message || "Failed to remove member");
		},
	});

	// Change group mutation
	const changeGroupMutation = useMutation({
		mutationFn: async ({
			userId,
			newGroup,
		}: {
			userId: string;
			newGroup: WorkspaceGroup;
		}) => {
			return orpc.documentWorkspaces.members.changeGroup.call({
				workspaceId,
				userId,
				newGroup,
			});
		},
		onSuccess: () => {
			toast.success("Member role updated");
			refetch();
		},
		onError: (error) => {
			toast.error(error.message || "Failed to update member role");
		},
	});

	if (isLoading) {
		return (
			<div className="flex items-center justify-center py-12">
				<Spinner />
			</div>
		);
	}

	const {
		administrators = [],
		contributors = [],
		stakeholders = [],
		agents = [],
	} = members || {};

	return (
		<div className="space-y-6">
			{/* Add Member */}
			<Card>
				<CardHeader>
					<CardTitle>Add Member</CardTitle>
					<CardDescription>
						Search for users to add to this workspace
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div className="flex gap-4">
						<div className="relative flex-1">
							<SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
							<SearchInput
								placeholder="Search by name or email..."
								value={searchQuery}
								onChange={(e) => setSearchQuery(e.target.value)}
								className="pl-9"
							/>
						</div>
						<Select
							value={selectedGroup}
							onValueChange={(v) =>
								setSelectedGroup(v as WorkspaceGroup)
							}
						>
							<SelectTrigger className="w-40">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="administrators">
									Administrator
								</SelectItem>
								<SelectItem value="contributors">
									Contributor
								</SelectItem>
								<SelectItem value="stakeholders">
									Stakeholder
								</SelectItem>
							</SelectContent>
						</Select>
					</div>

					{/* Search Results */}
					{debouncedSearch && (
						<div className="mt-4 border rounded-lg divide-y">
							{isSearching ? (
								<div className="p-4 text-center text-muted-foreground">
									Searching...
								</div>
							) : searchResults?.length === 0 ? (
								<div className="p-4 text-center text-muted-foreground">
									No users found
								</div>
							) : (
								searchResults?.map((user) => (
									<div
										key={user.id}
										className="flex items-center justify-between p-3"
									>
										<div className="flex items-center gap-3">
											<Avatar className="h-8 w-8">
												<AvatarImage
													src={
														user.image || undefined
													}
												/>
												<AvatarFallback>
													{user.name?.charAt(0) ||
														user.email?.charAt(0) ||
														"U"}
												</AvatarFallback>
											</Avatar>
											<div>
												<div className="font-medium">
													{user.name}
												</div>
												<div className="text-sm text-muted-foreground">
													{user.email}
												</div>
											</div>
										</div>
										<Button
											size="sm"
											onClick={() =>
												addMemberMutation.mutate({
													userId: user.id,
													group: selectedGroup,
												})
											}
											disabled={
												addMemberMutation.isPending
											}
										>
											<PlusIcon className="h-4 w-4 mr-1" />
											Add
										</Button>
									</div>
								))
							)}
						</div>
					)}
				</CardContent>
			</Card>

			{/* Current Members */}
			<div className="space-y-4">
				{/* Administrators */}
				<MemberGroup
					title="Administrators"
					description={GROUP_DESCRIPTIONS.administrators}
					members={administrators}
					onRemove={(userId) => removeMemberMutation.mutate(userId)}
					onChangeGroup={(userId, newGroup) =>
						changeGroupMutation.mutate({ userId, newGroup })
					}
					currentGroup="administrators"
				/>

				{/* Contributors */}
				<MemberGroup
					title="Contributors"
					description={GROUP_DESCRIPTIONS.contributors}
					members={contributors}
					onRemove={(userId) => removeMemberMutation.mutate(userId)}
					onChangeGroup={(userId, newGroup) =>
						changeGroupMutation.mutate({ userId, newGroup })
					}
					currentGroup="contributors"
				/>

				{/* Stakeholders */}
				<MemberGroup
					title="Stakeholders"
					description={GROUP_DESCRIPTIONS.stakeholders}
					members={stakeholders}
					onRemove={(userId) => removeMemberMutation.mutate(userId)}
					onChangeGroup={(userId, newGroup) =>
						changeGroupMutation.mutate({ userId, newGroup })
					}
					currentGroup="stakeholders"
				/>

				{/* Agents */}
				{agents.length > 0 && (
					<Card>
						<CardHeader>
							<CardTitle className="text-base">
								AI Agents
							</CardTitle>
							<CardDescription>
								Agents with read-only access to workspace
								documents
							</CardDescription>
						</CardHeader>
						<CardContent>
							<div className="space-y-2">
								{agents.map((agent) => (
									<div
										key={agent.agentId}
										className="flex items-center justify-between p-2 rounded-lg bg-muted/50"
									>
										<div className="flex items-center gap-3">
											<div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center">
												<UserIcon className="h-4 w-4 text-primary" />
											</div>
											<span className="font-medium">
												{agent.agentId}
											</span>
										</div>
										<Badge variant="secondary">Agent</Badge>
									</div>
								))}
							</div>
						</CardContent>
					</Card>
				)}
			</div>
		</div>
	);
}

interface MemberGroupProps {
	title: string;
	description: string;
	members: Array<{
		userId: string;
		user: {
			id: string;
			name: string;
			email: string;
			image: string | null;
		};
	}>;
	onRemove: (userId: string) => void;
	onChangeGroup: (userId: string, newGroup: WorkspaceGroup) => void;
	currentGroup: WorkspaceGroup;
}

function MemberGroup({
	title,
	description,
	members,
	onRemove,
	onChangeGroup,
	currentGroup,
}: MemberGroupProps) {
	if (members.length === 0) {
		return null;
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-base">{title}</CardTitle>
				<CardDescription>{description}</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="space-y-2">
					{members.map((member) => (
						<div
							key={member.userId}
							className="flex items-center justify-between p-2 rounded-lg bg-muted/50"
						>
							<div className="flex items-center gap-3">
								<Avatar className="h-8 w-8">
									<AvatarImage
										src={member.user.image || undefined}
									/>
									<AvatarFallback>
										{member.user.name?.charAt(0) ||
											member.user.email?.charAt(0) ||
											"U"}
									</AvatarFallback>
								</Avatar>
								<div>
									<div className="font-medium">
										{member.user.name}
									</div>
									<div className="text-sm text-muted-foreground">
										{member.user.email}
									</div>
								</div>
							</div>
							<div className="flex items-center gap-2">
								<Select
									value={currentGroup}
									onValueChange={(v) =>
										onChangeGroup(
											member.userId,
											v as WorkspaceGroup,
										)
									}
								>
									<SelectTrigger className="w-32 h-8">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="administrators">
											Administrator
										</SelectItem>
										<SelectItem value="contributors">
											Contributor
										</SelectItem>
										<SelectItem value="stakeholders">
											Stakeholder
										</SelectItem>
									</SelectContent>
								</Select>
								<Button
									variant="ghost"
									size="icon-sm"
									onClick={() => onRemove(member.userId)}
								>
									<TrashIcon className="h-4 w-4 text-destructive" />
								</Button>
							</div>
						</div>
					))}
				</div>
			</CardContent>
		</Card>
	);
}
