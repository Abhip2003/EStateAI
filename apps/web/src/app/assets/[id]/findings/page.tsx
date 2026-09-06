import { FindingsView } from './FindingsView';

export default async function FindingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <FindingsView assetId={id} />;
}
