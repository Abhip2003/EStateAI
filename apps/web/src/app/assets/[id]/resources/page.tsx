import { ResourcesView } from './ResourcesView';

export default async function ResourcesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ResourcesView assetId={id} />;
}
