import { db } from './db';

function normalizeName(value: string) { return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ar-YE'); }

export async function verifyPayoutAccount(params: { userId: string; provider: string; accountIdentifierEncrypted: string; accountIdentifierMasked: string; accountHolderName: string }) {
  const user = await db.user.findUnique({ where: { id: params.userId } });
  if (!user) throw new Error('USER_NOT_FOUND');
  const providerUrl = process.env.BANK_PROVIDER_URL;
  const secret = process.env.BANK_PROVIDER_SECRET;
  if (!providerUrl || !secret) throw new Error('NOT_CONFIGURED:BANK_PROVIDER_REQUIRED');
  const response = await fetch(providerUrl, { method:'POST', headers:{'content-type':'application/json','authorization':`Bearer ${secret}`}, body:JSON.stringify({ provider:params.provider, accountIdentifier:params.accountIdentifierEncrypted, holderName:params.accountHolderName }) });
  if (!response.ok) throw new Error('BANK_PROVIDER_FAILED');
  const result = await response.json() as { valid?:boolean; holderName?:string; providerReference?:string };
  if (!result.valid || !result.providerReference) throw new Error('PAYOUT_ACCOUNT_NOT_VERIFIED');
  const nameMatchStatus = result.holderName && normalizeName(result.holderName) === normalizeName(user.fullName) ? 'MATCH' : 'MISMATCH';
  return db.payoutAccount.create({ data:{ userId:user.id, provider:params.provider, accountIdentifierEncrypted:params.accountIdentifierEncrypted, accountIdentifierMasked:params.accountIdentifierMasked, accountHolderName:result.holderName ?? params.accountHolderName, verified:nameMatchStatus==='MATCH', nameMatchStatus, providerReference:result.providerReference } });
}
