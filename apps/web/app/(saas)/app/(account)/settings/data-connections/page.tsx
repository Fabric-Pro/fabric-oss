import { redirect } from "next/navigation";

export async function generateMetadata() {
	return {
		title: "Integrations",
	};
}

export default function DataConnectionsSettingsPage() {
	redirect("/app/settings/integrations");
}
