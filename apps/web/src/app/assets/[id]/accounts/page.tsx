import { AccountsView } from './AccountsView';

export default async function AccountsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AccountsView assetId={id} />;
}
