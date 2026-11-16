// Resolves when any active job settles or after `ms`, whichever is first, so the
// worker keeps claiming new jobs and running maintenance while long jobs run.
export async function waitForActivity(
  active: Set<Promise<void>>,
  ms: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wake = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([...active, wake]);
  } finally {
    clearTimeout(timer);
  }
}
