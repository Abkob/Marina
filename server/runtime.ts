export const isVercelRuntime = process.env.VERCEL === '1';
export const isProduction = process.env.NODE_ENV === 'production';

export function isAuthenticationRequired(): boolean {
  return isVercelRuntime || isProduction || process.env.MARINA_AUTH_REQUIRED === 'true';
}

export function isBlobStorageConfigured(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

export function canUseLocalPersistence(): boolean {
  return !isVercelRuntime;
}

export function runtimeCapabilities() {
  return {
    runtime: isVercelRuntime ? 'vercel' : 'local',
    auth_required: isAuthenticationRequired(),
    blob_uploads: isBlobStorageConfigured(),
    local_filesystem: canUseLocalPersistence(),
    local_background_workers: !isVercelRuntime,
    local_ollama: !isVercelRuntime,
  } as const;
}
