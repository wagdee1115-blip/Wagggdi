import { db } from './db';

export type NotificationPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL';
export type NotificationChannel = 'IN_APP' | 'SMS' | 'PUSH' | 'EMAIL';
export type NotificationType = 'TRANSFER_REQUEST'|'BUYER_APPROVAL'|'PAYMENT_CONFIRMED'|'ESCROW_HELD'|'SELLER_OTP'|'OWNERSHIP_TRANSFERRED'|'PAYOUT_PROTECTION'|'PAYOUT_CONFIRMED'|'REFUND'|'SECURITY_ALERT'|'NEW_LOGIN'|'AUCTION_WIN'|'AUCTION_BID'|'ADVERTISEMENT'|'SUPPORT_TICKET'|'DISPUTE';

export class UnconfiguredSmsProvider {
  configured = false;
  async sendSMS(): Promise<never> { throw new Error('NOT_CONFIGURED:SMS_PROVIDER_REQUIRED'); }
}

export class NotificationService {
  private smsProvider = new UnconfiguredSmsProvider();

  async sendNotification(params: { userId:string; type:NotificationType; title:string; message:string; priority?:NotificationPriority; channels?:NotificationChannel[]; operationId?:string; data?:unknown; phone?:string }) {
    const channels=params.channels??['IN_APP'];
    let notification=null;
    if(channels.includes('IN_APP')) notification=await db.notification.create({data:{userId:params.userId,type:params.type,title:params.title,message:params.message,priority:params.priority??'NORMAL',operationId:params.operationId,data:params.data as any}});
    if(channels.includes('SMS')) { try { await this.smsProvider.sendSMS(); } catch(e) { if(!(e instanceof Error&&e.message.startsWith('NOT_CONFIGURED'))) console.error(e); } }
    return notification;
  }
  async getNotifications(userId:string,unreadOnly=false){return db.notification.findMany({where:{userId,...(unreadOnly?{isRead:false}:{})},orderBy:{createdAt:'desc'},take:100});}
  async unreadCount(userId:string){return db.notification.count({where:{userId,isRead:false}});}
  async markAsRead(userId:string,notificationId:string){return db.notification.updateMany({where:{id:notificationId,userId},data:{isRead:true,readAt:new Date()}});}
  async markAllAsRead(userId:string){return db.notification.updateMany({where:{userId,isRead:false},data:{isRead:true,readAt:new Date()}});}
}
export const notificationService=new NotificationService();
