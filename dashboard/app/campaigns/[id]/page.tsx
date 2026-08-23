import { CampaignDetailClient } from '@/components/CampaignDetailClient';

export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CampaignDetailClient campaignId={decodeURIComponent(id)} />;
}
