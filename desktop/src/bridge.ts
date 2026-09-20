export interface DesktopContext {
  workspace: string;
  projectId: string;
  runtimePid: number;
  runtimeNode: string;
  fixture: boolean;
}
export interface DesktopBridge {
  context(): Promise<DesktopContext>;
  command(command: Record<string, unknown>): Promise<unknown>;
  events(sessionId: string, after: number): Promise<unknown>;
}
declare global { interface Window { harness: DesktopBridge } }
