import { RelationshipsView } from './RelationshipsView';

export default async function RelationshipsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RelationshipsView assetId={id} />;
}
