import { redirect } from "next/navigation";

export default async function IntegrationsPage() {
	redirect("/app/settings/integrations");
}
