import { createMcpModule } from './mcp.js';

/** Official remote MCP, fixed read-only catalog. The env value is a complete Bearer header. */
export function createGithubModule(options: { authorizationEnv: string; account: string }) {
  return createMcpModule({ id: 'github', version: '1', binding: options.account,
    instructions: `Read GitHub issues, pull requests and CI via the official remote service for configured account ${options.account}. Cite repository source links. Follow pagination and report incomplete results. These tools cannot write or trigger workflows.`,
    configuration: { schemaVersion: 1, servers: [{ name: 'github_remote', transport: 'http', url: 'https://api.githubcopilot.com/mcp/x/all/readonly',
      includeTools: ['search_issues', 'issue_read', 'search_pull_requests', 'pull_request_read', 'actions_list', 'actions_get'], permissions: ['read','network'],
      headerEnv: { Authorization: options.authorizationEnv } }] } });
}
