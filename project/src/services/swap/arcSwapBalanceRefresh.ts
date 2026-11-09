export async function refreshArcSwapBalances(
  refreshInput: () => Promise<{ isError: boolean }>,
  refreshOutput: () => Promise<{ isError: boolean }>,
): Promise<boolean> {
  const results = await Promise.all([refreshInput(), refreshOutput()]);
  return results.some((result) => result.isError);
}
