import { ComplianceView } from './ComplianceView';

export default async function CompliancePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ComplianceView assetId={id} />;
}
