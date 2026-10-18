import crypto from 'node:crypto';
import { query } from '../db.js';

const hash=(value:string)=>crypto.createHash('sha256').update(value).digest('hex');
export async function listScheduleShortcutKeys() {
  const result=await query('SELECT id,label,created_at,expires_at,last_used_at FROM schedule_shortcut_keys WHERE revoked_at IS NULL AND expires_at>NOW() ORDER BY created_at DESC');
  return result.rows;
}
export async function createScheduleShortcutKey(label:string) {
  // The plaintext is returned once. Database backups contain only its hash.
  const token=`marina_sc_${crypto.randomBytes(32).toString('base64url')}`;
  const id=crypto.randomUUID(),expiresAt=new Date(Date.now()+90*86400000).toISOString();
  await query(`INSERT INTO schedule_shortcut_keys(id,label,token_hash,expires_at) VALUES($1,$2,$3,$4)`,[id,label,hash(token),expiresAt]);
  return {id,token,expires_at:expiresAt};
}
export async function revokeScheduleShortcutKey(id:string) {
  await query('UPDATE schedule_shortcut_keys SET revoked_at=NOW() WHERE id=$1',[id]);
  return {revoked:true};
}
export async function authenticateScheduleShortcut(header:string|undefined) {
  if(!header||!/^Bearer marina_sc_[A-Za-z0-9_-]{43}$/.test(header))return false;
  const result=await query(`UPDATE schedule_shortcut_keys SET last_used_at=NOW() WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>NOW() RETURNING id`,[hash(header.slice(7))]);
  return result.rows.length===1;
}
