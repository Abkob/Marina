import type { Tab } from '../store/useAppStore';

export interface AppLocation {
  currentTab: Tab;
  selectedGoalId: string | null;
  focusedTaskId: string | null;
  focusedResourceId: string | null;
}
const views: Record<Tab, string> = {
  Schedule: 'schedule', Goals: 'goals', Work: 'work', 'Brain Dump': 'capture', Journal: 'journal',
  Copilot: 'copilot', Resources: 'resources', Topics: 'topics', Graph: 'connections', Gantt: 'timeline',
  Settings: 'settings', Usage: 'usage', Testing: 'diagnostics',
};
export function readAppLocation(url: URL): AppLocation | null {
  const currentTab = (Object.keys(views) as Tab[]).find(tab => views[tab] === url.searchParams.get('view'));
  if (!currentTab) return null;
  const selectedGoalId = currentTab === 'Goals' ? url.searchParams.get('goal') : null;
  return { currentTab, selectedGoalId, focusedTaskId: selectedGoalId ? url.searchParams.get('task') : null,
    focusedResourceId: currentTab === 'Resources' ? url.searchParams.get('resource') : null };
}
export function appLocationUrl(location: AppLocation, currentUrl: string) {
  const url = new URL(currentUrl);
  url.searchParams.set('view', views[location.currentTab]);
  for (const name of ['goal', 'task', 'resource']) url.searchParams.delete(name);
  if (location.currentTab === 'Goals' && location.selectedGoalId) {
    url.searchParams.set('goal', location.selectedGoalId);
    if (location.focusedTaskId) url.searchParams.set('task', location.focusedTaskId);
  }
  if (location.currentTab === 'Resources' && location.focusedResourceId) url.searchParams.set('resource', location.focusedResourceId);
  return url.pathname + url.search + url.hash;
}
export function appLocationKey(location: AppLocation) {
  return appLocationUrl(location, 'https://local.invalid/');
}
