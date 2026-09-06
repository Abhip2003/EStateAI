import { EventsView } from './EventsView';

export default async function EventsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <EventsView assetId={id} />;
}
