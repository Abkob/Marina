import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(process.cwd());

describe('Vercel deployment boundary', () => {
  it('routes API traffic to the serverless Express entry and the SPA to Vite', () => {
    const config = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8')) as {
      framework: string;
      outputDirectory: string;
      rewrites: Array<{ source: string; destination: string }>;
    };
    expect(config.framework).toBe('vite');
    expect(config.outputDirectory).toBe('dist');
    expect(config.rewrites).toContainEqual({ source: '/api/:path*', destination: '/api/index' });
    expect(config.rewrites).toContainEqual({ source: '/:path*', destination: '/index.html' });
  });

  it('does not start listeners, migrations, or seeders in the function entry', () => {
    const entry = fs.readFileSync(path.join(root, 'api/index.ts'), 'utf8');
    expect(entry).toContain('createApp()');
    expect(entry).not.toMatch(/\.listen\s*\(/);
    expect(entry).not.toContain('initSchema');
    expect(entry).not.toContain('seedIfEmpty');
  });

  it('keeps local data paths out of the deployment bundle', () => {
    const ignored = fs.readFileSync(path.join(root, '.vercelignore'), 'utf8');
    for (const required of ['.env', 'backups/', 'server/uploads/', 'tmp/']) {
      expect(ignored).toContain(required);
    }
  });
});
