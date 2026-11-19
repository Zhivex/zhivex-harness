export const shortCliHelp = (version: string) => `Zhivex Code v${version}

Start in your project:
  zhivex-code                         Open the conversation (first-use setup if needed)
  zhivex-code --continue              Reopen the latest conversation
  zhivex-code run "task"              Run one task for a script or automation
  zhivex-code doctor                  Check local configuration

Inside the console, type / for common actions or /help for guidance.
  zhivex-code init                    Configure a provider/model profile explicitly
  zhivex-code <command> --help        Show help for one command
  zhivex-code help all                Show every command and advanced option
  zhivex-code --version               Show the installed version

Requires Node >=22.13. The console guides API key setup; automation uses environment keys.
Use zhivex-code chat to open the conversation explicitly.`;
