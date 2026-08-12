import { db } from './db';
export async function redactPlateBeforePublic(mediaId:string,userId:string){
  const media=await db.vehicleMedia.findUnique({where:{id:mediaId},include:{vehicle:true}});if(!media)throw new Error('MEDIA_NOT_FOUND');if(media.vehicle.ownerId!==userId)throw new Error('FORBIDDEN');
  const url=process.env.PLATE_REDACTION_PROVIDER_URL,secret=process.env.PLATE_REDACTION_PROVIDER_SECRET;if(!url||!secret)throw new Error('NOT_CONFIGURED:PLATE_REDACTION_PROVIDER_REQUIRED');
  const r=await fetch(url,{method:'POST',headers:{authorization:`Bearer ${secret}`,'content-type':'application/json'},body:JSON.stringify({storageKey:media.originalStorageKey})});if(!r.ok)throw new Error('PLATE_REDACTION_FAILED');const d=await r.json() as {optimizedStorageKey?:string;plateDetected?:boolean};if(!d.optimizedStorageKey)throw new Error('PLATE_REDACTION_RESULT_MISSING');
  return db.vehicleMedia.update({where:{id:media.id},data:{optimizedStorageKey:d.optimizedStorageKey,plateDetectionStatus:d.plateDetected?'BLURRED':'CLEAR',publicStatus:'PUBLIC'}});
}
