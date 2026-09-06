import { DiscoveryView } from './DiscoveryView';

export default async function DiscoveryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DiscoveryView assetId={id} />;
}
