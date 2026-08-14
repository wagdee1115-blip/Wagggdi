import { getCurrentUser } from '@/lib/api-auth';
import { redactPlateBeforePublic } from '@/lib/plate-redaction';
export async function POST(_:Request,{ params }: { params: Promise<{id:string;mediaId:string}> }){try{const u=await getCurrentUser();if(!u)return Response.json({ok:false,error:'UNAUTHORIZED'},{status:401});const media=await redactPlateBeforePublic((await params).mediaId,u.id);return Response.json({ok:true,media});}catch(e){const m=e instanceof Error?e.message:'MEDIA_PUBLISH_FAILED';return Response.json({ok:false,error:m},{status:m.startsWith('NOT_CONFIGURED')?503:400});}}
