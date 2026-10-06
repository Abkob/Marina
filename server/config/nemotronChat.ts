/** User-selected chat scope. Document/embedding model roles are separate. */
export const NEMOTRON_SUPER_MODEL='nvidia/nemotron-3-super-120b-a12b';
export const NEMOTRON_ULTRA_MODEL='nvidia/nemotron-3-ultra-550b-a55b';
export const NEMOTRON_LIGHTNING_MODEL='nvidia/nemotron-3.5-lightning-30b-a3b';
export const NEMOTRON_CHAT_MODELS=[NEMOTRON_SUPER_MODEL,NEMOTRON_ULTRA_MODEL,NEMOTRON_LIGHTNING_MODEL] as const;
export function isNemotronChatModel(model:string):boolean {
  return (NEMOTRON_CHAT_MODELS as readonly string[]).includes(model);
}
export function configuredNemotronModel(model:string|undefined|null):string {
  return model&&isNemotronChatModel(model)?model:NEMOTRON_SUPER_MODEL;
}
/** Retired saved selections are readable; the next turn uses the current primary. */
export function savedNemotronModel(model:string|undefined|null,primary=NEMOTRON_SUPER_MODEL):string {
  return model&&isNemotronChatModel(model)?model:configuredNemotronModel(primary);
}
