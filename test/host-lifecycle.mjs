export async function settleHostDisposals(hosts) {
  const results = await Promise.allSettled(hosts.filter(Boolean).map(host => host.dispose()));
  return results.filter(result => result.status === "rejected").map(result => result.reason);
}

export function createHostDisposer({ runtime, errors, timeoutMs = 5_000 }) {
  let disposal;
  return () => disposal ??= (async () => {
    const priorErrors = errors.length;
    let timer;
    try {
      await Promise.race([
        runtime.dispose(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("host_shutdown_timeout")), timeoutMs); })
      ]);
    } catch (error) {
      throw error;
    } finally { if (timer) clearTimeout(timer); }
    if (errors.length !== priorErrors) throw new Error(`extension_shutdown_failed:${errors.slice(priorErrors).join("|")}`);
  })();
}
