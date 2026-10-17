export type StatusCopy = { title: string; next: string; detail?: string };

const human = (text: string) => text.replaceAll("_", " ").replaceAll("-", " ");

const known: Record<string, StatusCopy> = {
  EXECUTION_FAILED: {
    title: "The task stopped",
    next: "Edit the message below and send it again. The failed attempt is not run again on its own.",
  },
  WEB_REQUEST_FAILED: {
    title: "The connection dropped",
    next: "Choose Reconcile to reload this session. The last action is not sent again.",
    detail: "WEB REQUEST FAILED",
  },
  WEB_MODEL_CHANGE_BUSY: {
    title: "The model did not change",
    next: "Finish or cancel the work that is still running, then choose the model again.",
    detail: "WEB MODEL CHANGE BUSY",
  },
  WEB_MODEL_NOT_CONFIGURED: {
    title: "That model is not ready",
    next: "Configure the provider in the CLI, then reload this page. Credentials are never entered here.",
  },
  WEB_MODEL_SWITCH_FAILED: {
    title: "The model change did not finish",
    next: "Choose Reconcile to reload the host configuration before trying again.",
  },
  WEB_MODEL_UNAVAILABLE: {
    title: "Model choices are unavailable",
    next: "Restart the local launcher and open the paired tab again.",
  },
  WEB_PAIRING_REQUIRED: {
    title: "This tab is not paired",
    next: "Use the browser tab opened by zhivex-code web, or start it again.",
  },
  REVISION_CONFLICT: {
    title: "This review is out of date",
    next: "Reload the review, then approve or reject the current step.",
  },
  REVIEW_REQUIRED: {
    title: "Open a fresh review",
    next: "The previous decision was not sent again. Review the current step before you choose.",
  },
  REVIEW_EXPIRED: {
    title: "This review expired",
    next: "Reload the review, then approve or reject the current step.",
  },
  RUN_STATE_UNAVAILABLE: {
    title: "This run could not be read",
    next: "Choose Reconcile to reload it. Start a new session if it is still missing.",
  },
  WEB_CREDENTIALS_REQUIRED: {
    title: "No provider credentials are configured",
    next: "Configure a provider in the CLI, then reload this page.",
  },
  WEB_LIMIT_SETTINGS_INVALID: {
    title: "Those limits are not valid",
    next: "Check the amounts and save again.",
    detail: "WEB LIMIT SETTINGS INVALID",
  },
  WEB_LIMIT_STORAGE_UNSAFE: {
    title: "Limits could not be saved",
    next: "Choose Reconcile, then open limits again.",
    detail: "WEB LIMIT STORAGE UNSAFE",
  },
  WEB_LIMIT_REVISION_CONFLICT: {
    title: "Limits changed somewhere else",
    next: "Close the dialog and open it again before saving.",
  },
  INVALID_STATE: {
    title: "That message was not started",
    next: "Edit it if you need to, then send it again. It was not retried automatically.",
  },
};

/** Plain title plus the next thing the person can do. Raw codes stay in the detail line. */
export function statusCopy(code: string): StatusCopy {
  if (known[code]) return known[code];
  if (code.startsWith("The provider stream failed:")) {
    return {
      title: "The model stream stopped",
      next: "Edit the message and send it again, or choose Reconcile to reload this session.",
      detail: human(code),
    };
  }
  return {
    title: "Something went wrong",
    next: "Choose Reconcile to reload this session before you try again.",
    detail: human(code),
  };
}
