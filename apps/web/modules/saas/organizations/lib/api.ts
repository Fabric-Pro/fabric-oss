import type { OrganizationMetadata } from "@repo/auth";
import { authClient } from "@repo/auth/client";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { getSeededOrganizationGuestFlag } from "./organization-guest-store";

type FullOrganizationData = NonNullable<
	Awaited<
		ReturnType<typeof authClient.organization.getFullOrganization>
	>["data"]
>;

export const orgInvitationsQueryKey = (organizationId: string) =>
	["orgInvitations", organizationId] as const;
export const useOrgInvitationsQuery = (organizationId: string) => {
	return useQuery({
		queryKey: orgInvitationsQueryKey(organizationId),
		queryFn: () =>
			orpcClient.organizations.invitations.list({ organizationId }),
	});
};

export const organizationListQueryKey = ["user", "organizations"] as const;
export const useOrganizationListQuery = () => {
	return useQuery({
		queryKey: organizationListQueryKey,
		queryFn: async () => {
			const { data, error } = await authClient.organization.list();

			if (error) {
				throw new Error(
					error.message || "Failed to fetch organizations",
				);
			}

			return data;
		},
	});
};

export const activeOrganizationQueryKey = (slug: string) =>
	["user", "activeOrganization", slug] as const;
export const useActiveOrganizationQuery = (
	slug: string,
	options?: {
		enabled?: boolean;
		/**
		 * Guest knowledge from the caller. When `true`, the Better Auth
		 * membership probe (which always 403s for project-scoped guests)
		 * is skipped and the thin guest org is fetched directly. When
		 * `false`/`undefined` the server-seeded store is consulted; with
		 * no knowledge either way, behavior is unchanged (probe +
		 * guest fallback).
		 */
		isGuest?: boolean;
	},
) => {
	return useQuery({
		queryKey: activeOrganizationQueryKey(slug),
		queryFn: async (): Promise<FullOrganizationData> => {
			// Guest fast-path: the org layout server-computes the guest
			// flag and seeds it (via `OrganizationGuestProvider`) into the
			// module store before any query effect fires. Read at FETCH
			// time, not hook render time — the primary consumer
			// (`ActiveOrganizationProvider`) mounts above the org layout,
			// so render-scope context can never reach it, and an early
			// render-scope read would bake a stale `undefined` into the
			// closure.
			const knownGuest =
				options?.isGuest ?? getSeededOrganizationGuestFlag(slug);
			if (knownGuest === true) {
				try {
					const guestOrg = await orpcClient.organizations.getGuestOrg(
						{ slug },
					);
					return guestOrg as unknown as FullOrganizationData;
				} catch {
					// Stale seed (e.g. the guest was promoted to a full
					// member mid-session) — fall through to the standard
					// membership path below.
				}
			}

			const { data, error } =
				await authClient.organization.getFullOrganization({
					query: {
						organizationSlug: slug,
					},
				});

			// Guest fallback: Better Auth's `getFullOrganization` requires
			// an OrganizationMember row, so a project-scoped guest hits
			// either `data === null` or a 403/404. Only fall through to
			// the oRPC guest endpoint on those specific signals — 5xx
			// and other errors are transient/server problems and must
			// not be masked by hitting a second endpoint, and must not
			// double the API load during an outage.
			const errStatus = (error as { status?: number } | null | undefined)
				?.status;
			const shouldTryGuestFallback =
				(!error && !data) || errStatus === 403 || errStatus === 404;
			if (shouldTryGuestFallback) {
				try {
					const guestOrg = await orpcClient.organizations.getGuestOrg(
						{ slug },
					);
					return guestOrg as unknown as FullOrganizationData;
				} catch {
					// fall through to the original error handling below
				}
			}

			if (error) {
				throw new Error(
					error.message || "Failed to fetch active organization",
				);
			}
			if (!data) {
				throw new Error("Organization not found");
			}

			return data;
		},
		enabled: options?.enabled,
	});
};

export const fullOrganizationQueryKey = (id: string) =>
	["fullOrganization", id] as const;
export const useFullOrganizationQuery = (id: string) => {
	return useQuery({
		queryKey: fullOrganizationQueryKey(id),
		queryFn: async () => {
			const { data, error } =
				await authClient.organization.getFullOrganization({
					query: {
						organizationId: id,
					},
				});

			if (error) {
				throw new Error(
					error.message || "Failed to fetch full organization",
				);
			}

			return data;
		},
	});
};

/*
 * Create organization
 */
const createOrganizationMutationKey = ["create-organization"] as const;
export const useCreateOrganizationMutation = () => {
	return useMutation({
		mutationKey: createOrganizationMutationKey,
		mutationFn: async ({
			name,
			metadata,
		}: {
			name: string;
			metadata?: OrganizationMetadata;
		}) => {
			const { slug } = await orpcClient.organizations.generateSlug({
				name,
			});

			const { error, data } = await authClient.organization.create({
				name,
				slug,
				metadata,
			});

			if (error) {
				throw error;
			}

			return data;
		},
	});
};

/*
 * Update organization
 */
const updateOrganizationMutationKey = ["update-organization"] as const;
export const useUpdateOrganizationMutation = () => {
	return useMutation({
		mutationKey: updateOrganizationMutationKey,
		mutationFn: async ({
			id,
			name,
			metadata,
			updateSlug,
		}: {
			id: string;
			name: string;
			metadata?: OrganizationMetadata;
			updateSlug?: boolean;
		}) => {
			const slug = updateSlug
				? (
						await orpcClient.organizations.generateSlug({
							name,
						})
					).slug
				: undefined;

			const { error, data } = await authClient.organization.update({
				organizationId: id,
				data: {
					name,
					slug,
					metadata,
				},
			});

			if (error) {
				throw error;
			}

			return data;
		},
	});
};
