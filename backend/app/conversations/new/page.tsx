import StartConversation from './start-conversation';

export default async function NewConversationPage({ searchParams }: { searchParams: Promise<{ listingId?: string | string[] }> }) {
  const { listingId } = await searchParams;
  return <StartConversation listingId={typeof listingId === 'string' ? listingId : ''} />;
}
