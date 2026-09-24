import { BookOpen, CalendarDays, FlaskConical, FolderOpen, Gauge, GanttChart, Settings, Share2, Tags, Target, Timer, Zap } from 'lucide-react';
import type { Tab } from '../store/useAppStore';

export const MOBILE_PAGES = [
  { id: 'Schedule', label: 'Schedule', description: 'Your day, at a glance', Icon: CalendarDays, group: 'Your day' },
  { id: 'Goals', label: 'Goals', description: 'Projects and next steps', Icon: Target, group: 'Your day' },
  { id: 'Work', label: 'Work', description: 'Focus and track time', Icon: Timer, group: 'Your day' },
  { id: 'Brain Dump', label: 'Capture', description: 'Thoughts and journal', Icon: BookOpen, group: 'Your day' },
  { id: 'Copilot', label: 'Copilot', description: 'Talk through your plans', Icon: Zap, group: 'Your workspace' },
  { id: 'Resources', label: 'Resources', description: 'Files, links and reading', Icon: FolderOpen, group: 'Your workspace' },
  { id: 'Topics', label: 'Topics', description: 'Organize your interests', Icon: Tags, group: 'Your workspace' },
  { id: 'Graph', label: 'Connections', description: 'Explore related ideas', Icon: Share2, group: 'Your workspace' },
  { id: 'Gantt', label: 'Timeline', description: 'Dates across your goals', Icon: GanttChart, group: 'Your workspace' },
  { id: 'Settings', label: 'Settings', description: 'Schedule and preferences', Icon: Settings, group: 'Manage' },
  { id: 'Usage', label: 'Usage', description: 'Storage and activity', Icon: Gauge, group: 'Manage' },
  { id: 'Testing', label: 'Diagnostics', description: 'Workspace health', Icon: FlaskConical, group: 'Manage' },
] satisfies { id: Tab; label: string; description: string; Icon: typeof CalendarDays; group: string }[];

export function mobilePageId(tab: Tab): Tab {
  return tab === 'Journal' ? 'Brain Dump' : tab === 'Gantt' ? 'Schedule' : tab;
}

export function mobilePageLabel(tab: Tab) {
  if (tab === 'Gantt') return 'Timeline';
  return MOBILE_PAGES.find(page => page.id === mobilePageId(tab))?.label ?? tab;
}
