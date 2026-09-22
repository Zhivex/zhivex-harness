import { resolveHarnessConfig } from "../runtime/config.js";
import { exportHarnessStateBackup, importHarnessStateBackupFile, inspectHarnessState } from "../persistence/state-backup.js";
import { CliUsageError, type CliOptions } from "./arguments.js";

export const manageState = async (options: CliOptions) => {
  const config = resolveHarnessConfig(options);
  let document: unknown;
  switch (options.stateCommand) {
    case "status":
      document = await inspectHarnessState(config);
      break;
    case "export":
      document = await exportHarnessStateBackup(config, options.backupPath!);
      break;
    case "import":
      document = await importHarnessStateBackupFile(config, options.backupPath!, {
        dryRun: !options.apply
      });
      break;
    default:
      throw new CliUsageError("state requires one of: status, export, import.");
  }
  process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
};
