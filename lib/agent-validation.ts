// A run may only publish after a real validation command passed. These checks
// keep an agent (possibly steered by untrusted issue text) from "validating"
// with something like `echo tests pass`.
const RUNNER =
  /^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|t|lint|build|typecheck|check|verify|ci)\b|(?:npx|pnpm exec|yarn dlx|bunx)\s+(?:vitest|jest|tsc|eslint|mocha|playwright|ava|tap)\b|(?:vitest|jest|tsc|eslint|mocha|pytest|tox|nox|rspec|phpunit|ruff|mypy|flake8)\b|node\s+--test\b|python3?\s+-m\s+(?:pytest|unittest|tox)\b|python3?\s+[\w./-]*test[\w./-]*\.py\b|go\s+(?:test|vet|build)\b|cargo\s+(?:test|check|build|clippy)\b|(?:make|gmake|just)\s+(?:test|tests|check|lint|build|verify)\b|(?:mvn|\.\/mvnw)\s+(?:-\S+\s+)*(?:test|verify|package)\b|(?:gradle|\.\/gradlew)\s+(?:\S+\s+)*(?:test|check|build)\b|dotnet\s+(?:test|build)\b|(?:rake|bundle exec rake)\s+(?:test|spec)\b|bundle exec rspec\b|bun\s+test\b|deno\s+(?:test|check|lint)\b|(?:\.\/|sh\s+|bash\s+)?[\w./-]*(?:test|check|lint|verify)[\w.-]*\.sh\b)/;
// Constructs that hide a failing exit status.
const SWALLOWS =
  /(\|\|\s*(?:true|:|echo\b|exit\s+0)|;\s*(?:true|:|exit\s+0)\s*$|\bexit\s+0\b|^\s*(?:echo|printf|true|:)\b)/;

export function isMeaningfulValidation(command: string) {
  if (SWALLOWS.test(command)) return false;
  return command
    .split(/&&|;|\n/)
    .map((part) => part.trim().replace(/^(?:cd\s+\S+\s*)$/, ""))
    .filter(Boolean)
    .some((segment) =>
      RUNNER.test(
        segment.replace(/^(?:\w+=\S+\s+)+/, "").replace(/^CI=\S+\s+/, ""),
      ),
    );
}

// Parses the persisted "$ command\n{json}" blocks and requires that the LAST
// meaningful validation exited 0 (an earlier pass cannot cover a later failure,
// and unrelated commands such as `ls` do not count).
export function hasPassingValidation(tests: string) {
  const blocks = [
    ...tests.matchAll(/(?:^|\n)\$ ([\s\S]*?)\n(\{"exitCode":[\s\S]*?\})\n/g),
  ];
  const meaningful = blocks.filter((block) => isMeaningfulValidation(block[1]));
  const last = meaningful.at(-1);
  if (!last) return false;
  try {
    return (JSON.parse(last[2]) as { exitCode?: number }).exitCode === 0;
  } catch {
    return false;
  }
}
