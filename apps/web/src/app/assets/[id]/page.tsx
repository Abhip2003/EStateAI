import { AssetOverview } from './AssetOverview';

export default async function AssetOverviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AssetOverview assetId={id} />;
}
