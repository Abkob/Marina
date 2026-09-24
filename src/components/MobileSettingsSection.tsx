import type { ReactNode } from 'react';
import { MobileDisclosure } from './MobileDisclosure';

export function MobileSettingsSection({ title, description, children, defaultOpen = false }: { title: string; description: string; children: ReactNode; defaultOpen?: boolean }) {
  return <MobileDisclosure title={title} description={description} storageKey={`settings-${title}`} defaultOpen={defaultOpen}><div className="space-y-3">{children}</div></MobileDisclosure>;
}
