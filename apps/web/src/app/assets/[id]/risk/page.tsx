import { RiskView } from './RiskView';

export default async function RiskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RiskView assetId={id} />;
}
