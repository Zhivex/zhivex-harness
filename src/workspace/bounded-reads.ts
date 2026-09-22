/** Ordered batches bound in-flight work and drain failures before returning.
 * Consumers can stop early without leaving background reads or writes running.
 */
export async function* boundedBatches<T, R>(
  items: readonly T[],
  operation: (item: T) => Promise<R>,
  concurrency = 8
): AsyncGenerator<R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error("Invalid concurrency.");
  for (let offset = 0; offset < items.length; offset += concurrency) {
    const results = await Promise.allSettled(items.slice(offset, offset + concurrency).map(async (item) => operation(item)));
    const failure = results.find((result) => result.status !== "fulfilled");
    if (failure?.status === "rejected") throw failure.reason;
    yield results.map((result) => (result as PromiseFulfilledResult<R>).value);
  }
}
