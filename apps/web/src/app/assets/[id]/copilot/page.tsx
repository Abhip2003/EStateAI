import { CopilotView } from './CopilotView';

export default async function CopilotPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CopilotView assetId={id} />;
}
