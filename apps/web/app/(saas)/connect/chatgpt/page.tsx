import {
	findChatGptPlanPoolAdminOrganization,
	listChatGptPlanOrganizations,
} from "@repo/database";
import { getSession } from "@saas/auth/lib/server";
import {
	ConnectChatgptPlanForm,
	ConnectSharedChatgptPlanForm,
} from "@saas/settings/components/chatgpt-plan/ConnectChatgptPlanForm";
import { AuthWrapper } from "@saas/shared/components/AuthWrapper";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function generateMetadata() {
	const t = await getTranslations("settings.chatgptPlan.connect");
	return { title: t("title") };
}

/** The CLI's loopback port: an unprivileged port, nothing else. */
function parsePort(raw: string | string[] | undefined): number | null {
	const port =
		typeof raw === "string" && /^\d{4,5}$/.test(raw) ? Number(raw) : 0;
	return port >= 1024 && port <= 65535 ? port : null;
}

function parseState(raw: string | string[] | undefined): string | null {
	return typeof raw === "string" && /^[\w-]{8,128}$/.test(raw) ? raw : null;
}

function parseSlug(raw: string | string[] | undefined): string | null {
	return typeof raw === "string" && /^[\w-]{1,200}$/.test(raw) ? raw : null;
}

/**
 * Where `fabric connect chatgpt` sends the person to approve the connection
 * (Fizzy #2939). The session proves who they are; approving mints a one-time
 * upload ticket that is handed back only to the CLI's own 127.0.0.1 listener.
 */
export default async function ConnectChatgptPlanPage({
	searchParams,
}: {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const session = await getSession();
	if (!session) {
		redirect("/auth/login");
	}
	const params = await searchParams;
	const port = parsePort(params.port);
	const state = parseState(params.state);

	// `fabric connect chatgpt --org <slug> --shared` (Fizzy #2770): a shared
	// account for one organization the person administers. The approve route
	// checks the same again; this only decides what the page shows.
	if (params.shared === "1") {
		const slug = parseSlug(params.org);
		const organization = slug
			? await findChatGptPlanPoolAdminOrganization({
					userId: session.user.id,
					slug,
				})
			: null;
		return (
			<AuthWrapper>
				<ConnectSharedChatgptPlanForm
					organization={
						organization && slug
							? { slug, name: organization.name }
							: null
					}
					port={port}
					state={state}
				/>
			</AuthWrapper>
		);
	}

	const organizations = await listChatGptPlanOrganizations({
		userId: session.user.id,
	});

	return (
		<AuthWrapper>
			<ConnectChatgptPlanForm
				email={session.user.email}
				organizations={organizations.map(({ id, name, enabled }) => ({
					id,
					name,
					enabled,
				}))}
				port={port}
				state={state}
			/>
		</AuthWrapper>
	);
}
