import { RecommendationsView } from './RecommendationsView';

export default async function RecommendationsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RecommendationsView assetId={id} />;
}
