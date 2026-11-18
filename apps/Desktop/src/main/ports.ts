import { createServer, type AddressInfo } from 'node:net';

export function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
}

/** The preferred port when it is free, otherwise any free port the system hands out. */
export async function pickPort(preferred: number, taken: readonly number[]): Promise<number> {
  if (!taken.includes(preferred) && (await isPortFree(preferred))) return preferred;
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      // The system can hand out a port this app already reserved but has not bound yet.
      /* v8 ignore next */
      probe.close(() => resolve(taken.includes(port) ? pickPort(preferred, taken) : port));
    });
  });
}
