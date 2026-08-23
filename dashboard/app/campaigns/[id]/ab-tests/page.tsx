import { ABTestsClient } from '@/components/ABTestsClient';

export default async function ABTestsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ABTestsClient campaignId={decodeURIComponent(id)} />;
}
