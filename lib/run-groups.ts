// Issues may share one run only when they come from the same repository and
// GitHub identity; a run holds at most four.
export function compatibleGroups<
  T extends { repo: string; identityId: string },
>(issues: T[]) {
  const map = new Map<string, T[]>();
  for (const issue of issues) {
    const key = issue.repo + ":" + issue.identityId;
    const same = map.get(key) ?? [];
    same.push(issue);
    map.set(key, same);
  }
  return [...map.values()].flatMap((items) =>
    Array.from({ length: Math.ceil(items.length / 4) }, (_, index) =>
      items.slice(index * 4, index * 4 + 4),
    ),
  );
}
