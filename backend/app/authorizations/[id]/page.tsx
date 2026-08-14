import AuthorizationDetailClient from './authorization-detail-client';

export default async function AuthorizationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AuthorizationDetailClient id={id}/>;
}
