import {afterEach,describe,it,expect,vi} from 'vitest';
import {NEMOTRON_CHAT_MODELS,NEMOTRON_SUPER_MODEL,savedNemotronModel} from '../../../server/config/nemotronChat.js';
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();vi.resetModules();});
describe('Nemotron-only chat selection',()=>{
 it('keeps retired saved chats usable while preserving supported selections',()=>{
  for(const retired of ['gemini-3.8-flash','moonshotai/kimi-k3','deepseek-ai/deepseek-v4-pro','qwen3:8b',null])
   expect(savedNemotronModel(retired)).toBe(NEMOTRON_SUPER_MODEL);
  expect(savedNemotronModel('gemini-3.8-flash',NEMOTRON_CHAT_MODELS[1])).toBe(NEMOTRON_CHAT_MODELS[1]);
  for(const supported of NEMOTRON_CHAT_MODELS)expect(savedNemotronModel(supported)).toBe(supported);
 });
 it('stale environment values cannot re-enable another provider or fallback',async()=>{
  vi.resetModules();vi.stubEnv('MARINA_MAIN_MODEL','gemini-3.8-flash');vi.stubEnv('MARINA_NVIDIA_NEMOTRON_MODEL','z-ai/glm-5.3');
  vi.stubEnv('MARINA_NVIDIA_FALLBACK_MODEL','deepseek-ai/deepseek-v4-pro');vi.stubEnv('MARINA_LOCAL_FALLBACK_MODEL','qwen3:8b');
  vi.stubEnv('MARINA_PLANNING_GROUNDING_MODEL','gemini-3.8-flash');vi.stubEnv('GEMINI_API_KEY','embedding-key');
  const config=await import('../../../server/config/providers.js');
  expect(config.CHAT_MODEL_PRIMARY).toBe(NEMOTRON_SUPER_MODEL);expect(config.SELECTABLE_CHAT_MODELS).toEqual([...NEMOTRON_CHAT_MODELS]);
  expect(config.NVIDIA_FALLBACK_MODEL).toBe('');expect(config.CHAT_MODEL_FALLBACK).toBe('');expect(config.LOCAL_CHAT_ENABLED).toBe(false);
  expect(config.getProviderSummary().chat.nvidia_fallback_configured).toBe(false);
  expect(config.getProviderSummary().embeddings).toMatchObject({provider:'gemini',api_key_present:true});
 });
 it('allows only explicit Nemotron fallbacks and leaves the default disabled',async()=>{
  vi.resetModules();vi.stubEnv('MARINA_NVIDIA_FALLBACK_MODEL',NEMOTRON_CHAT_MODELS[2]);
  expect((await import('../../../server/config/providers.js')).NVIDIA_FALLBACK_MODEL).toBe(NEMOTRON_CHAT_MODELS[2]);
 });
 it.each(['gemini-3.8-flash','openai/gpt-oss-120b','moonshotai/kimi-k3','deepseek-ai/deepseek-v4-pro','z-ai/glm-5.3','qwen3:8b'])('rejects an explicit retired model %s before any network request',async model=>{
  vi.resetModules();const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  const {chat}=await import('../../../server/ollama.js');await expect(chat([{role:'user',content:'hi'}],{model})).rejects.toThrow('Unsupported chat model');
  expect(fetch).not.toHaveBeenCalled();
 });
});
