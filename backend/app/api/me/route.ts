import { getCurrentUser } from '@/lib/api-auth';
export async function GET(){ const u=await getCurrentUser(); if(!u)return Response.json({ok:false,error:'UNAUTHORIZED'},{status:401}); return Response.json({ok:true,user:{id:u.id,fullName:u.fullName,role:u.role,status:u.status,identityStatus:u.identityStatus,phoneStatus:u.phoneStatus,email:u.email,phone:u.phone}}); }
