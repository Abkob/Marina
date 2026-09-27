export interface TargetableTask {
  id: string;
  title: string;
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with',
  'task', 'tasks', 'project',
]);

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function meaningfulTokens(value: string): string[] {
  return normalize(value)
    .split(/\s+/)
    .filter(token => token && !STOP_WORDS.has(token));
}

function editDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[b.length];
}

function tokensMatch(titleToken: string, queryToken: string): boolean {
  if (titleToken === queryToken) return true;
  if (titleToken.length < 4 || queryToken.length < 4) return false;
  if (titleToken.length === queryToken.length) {
    for (let index = 0; index < titleToken.length - 1; index++) {
      const swapped = titleToken.slice(0, index)
        + titleToken[index + 1]
        + titleToken[index]
        + titleToken.slice(index + 2);
      if (swapped === queryToken) return true;
    }
  }
  const maxDistance = Math.max(1, Math.floor(Math.max(titleToken.length, queryToken.length) / 4));
  return editDistance(titleToken, queryToken) <= maxDistance;
}

/**
 * Finds tasks that the user explicitly names, tolerating the small typos that
 * are common in conversational task references. Generic schedule queries do
 * not select arbitrary retrieval results.
 */
export function findExplicitTaskMatches(
  query: string | null | undefined,
  tasks: TargetableTask[],
  limit = 4,
): string[] {
  const normalizedQuery = normalize(query ?? '');
  if (!normalizedQuery) return [];
  if (/\b(proactive|smart)\b.*\breview\b|\bentire\s+planning\s+system\b|\bevery\s+active\s+goal\b/.test(normalizedQuery)) {
    return [];
  }
  const queryTokens = meaningfulTokens(normalizedQuery);

  return tasks
    .flatMap(task => {
      const normalizedTitle = normalize(task.title);
      const titleTokens = meaningfulTokens(normalizedTitle);
      if (!normalizedTitle || !titleTokens.length) return [];

      const exactPhrase = normalizedQuery.includes(normalizedTitle);
      const matchedTokens = titleTokens.filter(titleToken =>
        queryTokens.some(queryToken => tokensMatch(titleToken, queryToken)));
      const allTokensMatch = matchedTokens.length === titleTokens.length;
      const strongPartial = titleTokens.length >= 3
        && matchedTokens.length >= 2
        && matchedTokens.length / titleTokens.length >= 0.7;

      if (!exactPhrase && !allTokensMatch && !strongPartial) return [];
      return [{
        id: task.id,
        score: exactPhrase ? 3 : allTokensMatch ? 2 : 1,
        coverage: matchedTokens.length / titleTokens.length,
        titleLength: normalizedTitle.length,
      }];
    })
    .sort((a, b) =>
      b.score - a.score
      || b.coverage - a.coverage
      || b.titleLength - a.titleLength)
    .slice(0, limit)
    .map(match => match.id);
}
