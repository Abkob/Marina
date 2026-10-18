import { describe, expect, it } from 'vitest';
import { pushSubscriptionSchema } from '../../../server/services/schedulePush';
describe('schedule push endpoint safety',()=>{
 const subscription=(endpoint:string)=>({endpoint,keys:{p256dh:'a'.repeat(87),auth:'b'.repeat(22)}});
 it('accepts the iPhone push service and rejects private or arbitrary endpoints',()=>{
  expect(pushSubscriptionSchema.safeParse(subscription('https://web.push.apple.com/test-device')).success).toBe(true);
  for(const url of ['http://127.0.0.1/push','https://127.0.0.1/push','https://evil.example/push','https://web.push.apple.com.evil.example/push','https://web.push.apple.com:444/push','https://user:pass@web.push.apple.com/push'])expect(pushSubscriptionSchema.safeParse(subscription(url)).success).toBe(false);
 });
});
