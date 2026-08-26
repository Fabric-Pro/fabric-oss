import { UnsubscribeConfirm } from "./UnsubscribeConfirm";

export default async function UnsubscribePage({
	params,
}: {
	params: Promise<{ token: string }>;
}) {
	const { token } = await params;
	return <UnsubscribeConfirm token={token} />;
}
