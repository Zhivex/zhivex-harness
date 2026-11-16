import { launchDockerMcpTools } from '../execution/mcp-oci-server.js';

export type IsolatedMcpLaunchOptions = Omit<Parameters<typeof launchDockerMcpTools>[0], 'resourceJournal'>;

/** Returns only the opaque harness capability and lifecycle control, not raw tools. */
export async function launchIsolatedMcpSession(options: IsolatedMcpLaunchOptions) {
  const session = await launchDockerMcpTools(options);
  return Object.freeze({ hostSession: session.hostSession, close: session.close });
}
