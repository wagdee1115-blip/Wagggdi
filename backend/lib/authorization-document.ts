import { createHash } from 'crypto';
import { db } from './db';
function escapeHtml(value:string){return value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));}
export async function issueAuthorizationDocument(authorizationId:string){
  const auth=await db.vehicleAuthorization.findUnique({where:{id:authorizationId},include:{vehicle:true,owner:true,authorizedUser:true}});
  if(!auth)throw new Error('AUTHORIZATION_NOT_FOUND');
  const payload={authorizationNumber:auth.authorizationNumber,vehicleId:auth.vehicleId,ownerId:auth.ownerId,authorizedUserId:auth.authorizedUserId,type:auth.type,minPrice:auth.minPrice?.toString()??null,validUntil:auth.validUntil.toISOString(),termsVersion:auth.termsVersion,qrValue:auth.qrValue??null};
  const hash=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const html=`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>${escapeHtml(auth.authorizationNumber)}</title><body style="font-family:Arial;padding:40px"><h1>تفويض بيع مركبة - مركبات</h1><p>رقم التفويض: ${escapeHtml(auth.authorizationNumber)}</p><p>المالك: ${escapeHtml(auth.owner.fullName)}</p><p>المفوض: ${escapeHtml(auth.authorizedUser.fullName)}</p><p>المركبة: ${escapeHtml(auth.vehicle.make)} ${escapeHtml(auth.vehicle.model)} ${auth.vehicle.year}</p><p>النوع: ${auth.type}</p><p>ساري حتى: ${auth.validUntil.toLocaleString('ar-YE')}</p><p>SHA-256: ${hash}</p><p>QR Payload: ${escapeHtml(auth.qrValue ?? '')}</p><p>هذا المستند ليس سندًا حكوميًا أو ضمانًا للحجية القانونية دون الاعتماد والترخيص المناسبين.</p></body></html>`;
  const storageUrl=process.env.AUTHORIZATION_DOCUMENT_STORAGE_URL;
  if(!storageUrl)throw new Error('NOT_CONFIGURED:AUTHORIZATION_DOCUMENT_STORAGE_REQUIRED');
  const response=await fetch(storageUrl,{method:'POST',headers:{'content-type':'application/json','authorization':`Bearer ${process.env.AUTHORIZATION_DOCUMENT_STORAGE_SECRET??''}`},body:JSON.stringify({authorizationId,html,fileName:`${auth.authorizationNumber}.pdf`,format:'pdf'})});
  if(!response.ok)throw new Error('AUTHORIZATION_DOCUMENT_UPLOAD_FAILED');
  const result=await response.json() as {url?:string};
  if(!result.url)throw new Error('AUTHORIZATION_DOCUMENT_URL_MISSING');
  return db.vehicleAuthorization.update({where:{id:authorizationId},data:{pdfUrl:result.url,sha256Hash:hash}});
}
