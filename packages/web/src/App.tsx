import { TaskPanel } from './TaskPanel.js';
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ModelPicker } from "./ModelPicker.js";
import { AddProjectDialog, SessionsDrawer, type DrawerProject } from "./SessionsDrawer.js";
import { applyTheme, readThemeChoice, THEME_KEY, type ThemeChoice } from "./theme.js";
import { runStatusLabel, sessionStatusLabel } from "./status-label.js";
import { clampDiffHeight, clampDiffWidth, defaultDiffLayout, DIFF_LAYOUT_KEY, DIFF_MIN_HEIGHT, DIFF_MIN_WIDTH, effectiveDiffPosition, EMPTY_DIFF_WIDTH, maxDiffHeight, maxDiffWidth, nextDiffPosition, nudgeDiffSize, readDiffLayout, sideFits, NARROW_TABS, type DiffLayoutPreference, type DiffPosition } from "./diff-layout.js";
import { altShiftAction, isTextField } from "./shortcuts.js";
import { choiceKey } from "./model-choice.js";
import type { WebProjectOverview } from "./contracts.js";
import { ChatEmptyState, ChatRoot, Composer, Message, ReviewCard } from "@zhivex-ai/react/components";
import { useViewedFiles, reviewConsequence, preventDecisionEnter } from "../../../desktop/src/review-ui.js";
import { FileDiff } from "../../../desktop/src/FileDiff.js";
import {
  applyActivityPage,
  emptyActivity,
  type ConversationActivity,
} from "../../../desktop/src/activity.js";
import { action, context, reconnect } from "./api.js";
import { ModelSelectionRejectedError } from "./request-failure.js";
import { ComposerDrafts } from "./composer-drafts.js";
import "./composer.css";
import { counted, limitsReadError, limitsSaveError } from "./limit-copy.js";
import { LimitsDialog } from "./LimitsDialog.js";
import { ApprovalModeDialog, type ApprovalMode, type ApprovalRecord } from "./ApprovalModeDialog.js";
import type { LimitSettings, LimitScope } from "./limit-settings.js";
import type { LimitPreferences } from "./limit-store.js";
import type { RunLimits, LimitPricing } from "./limit-observer.js";
import { DesktopIcon, MoonIcon, PlusIcon, SlidersHorizontalIcon, SunIcon } from "@phosphor-icons/react";
import { planComposerSend } from "./composer-plan.js";
import { cancellationSupersedesFailure, mutationUnconfirmed } from "./mutation-outcome.js";
import { statusCopy } from "./status-copy.js";
import { groupToolRows, isReadOnlyTool } from "./activity-groups.js";
import { MessageMarkdown } from "./MessageMarkdown.js";
import { providerStreamFailureText } from "./provider-stream-failure.js";
import type {
  WebContext,
  HarnessClientRun,
  HarnessClientSession,
  HarnessActivityPage,
  TicketedApprovalReview,
  WebModelChoice,
} from "./contracts.js";

type Sessions = {
  data: { kind: "sessions"; sessions: HarnessClientSession[] };
};
type Session = { data: { kind: "session"; session: HarnessClientSession } };
type Run = {
  data: { kind: "run"; session: HarnessClientSession; run: HarnessClientRun };
};
const key = () => crypto.randomUUID();
type LimitsInfo = { workspaceKey: string; legacyPending?: boolean; preferences: LimitPreferences; pricing: LimitPricing | null;
  host: { costUsd: number | null; steps: number | null; toolCalls: number | null; tokens: number | null; durationMinutes: number | null } };
const human = (text: string) => text.replaceAll("_", " ").replaceAll("-", " ");
const hostLimitNote = (host: LimitsInfo["host"]) => Object.entries(host).filter(([, value]) => value !== null).map(([name, value]) => {
  if (name === "costUsd") return ` Host: ${value} estimated USD (not a guaranteed financial cap).`;
  const singular = name === "steps" ? "step" : name === "toolCalls" ? "tool call" : name === "tokens" ? "token" : "minute";
  return ` Host: ${counted(Number(value), singular)}.`;
}).join("");
const active = (status: string) =>
  ["running", "created", "queued", "cancel_requested"].includes(status);
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "WEB_REQUEST_FAILED";

export function App() {
  const [modelChoices, setModelChoices] = useState<WebModelChoice[]>([]);
  const [modelError, setModelError] = useState("");
  const [modelSelectionError, setModelSelectionError] = useState("");
  const [modelsLoading, setModelsLoading] = useState(false);
  const [ctx, setContext] = useState<WebContext>();
  const [workspaceKey, setWorkspaceKey] = useState("");
  const [sessions, setSessions] = useState<HarnessClientSession[]>([]);
  const [session, setSession] = useState<HarnessClientSession>();
  const [activity, setActivity] = useState<ConversationActivity>(emptyActivity);
  const activityRef = useRef(activity);
  activityRef.current = activity;
  const [run, setRun] = useState<HarnessClientRun>();
  const [runUnavailable, setRunUnavailable] = useState(false);
  const [hasTask, setHasTask] = useState(false);
  const [review, setReview] = useState<TicketedApprovalReview>();
  const viewed = useViewedFiles(review, run?.runId, run?.revision);
  const [prompt, setPrompt] = useState("");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  const [pending, setPending] = useState("");
  const inFlight = useRef(false);
  const cancelInFlight = useRef(false);
  const recordedCancellations = useRef(0);
  const [cancelling, setCancelling] = useState(false);
  const reconnectInFlight = useRef(false);
  const [reconnecting, setReconnecting] = useState(false);
  const mutationEpoch = useRef(0);
  const contextEpoch = useRef(0);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [stateLoading, setStateLoading] = useState(false);
  const [needsReconcile, setNeedsReconcile] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [reviewDeadline, setReviewDeadline] = useState(0);
  const focusPrompt = useRef(false);
  const runRef = useRef(run);
  runRef.current = run;
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const drafts = useRef(new ComposerDrafts());
  const [refresh, setRefresh] = useState(0);
  const [limitsInfo, setLimitsInfo] = useState<LimitsInfo>();
  const [limitsOpen, setLimitsOpen] = useState(false);
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>("manual");
  const [approvalRecords, setApprovalRecords] = useState<ApprovalRecord[]>([]);
  const [approvalSaving, setApprovalSaving] = useState(false);
  const [limitsSaving, setLimitsSaving] = useState(false);
  const limitsSavingRef = useRef(false);
  const [limitsError, setLimitsError] = useState("");
  const [runLimits, setRunLimits] = useState<RunLimits | null>(null);
  const [themeChoice, setThemeChoice] = useState<ThemeChoice>(() => readThemeChoice(globalThis.localStorage));
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">("dark");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [overview, setOverview] = useState<WebProjectOverview[]>([]);
  const [extraSessions, setExtraSessions] = useState<Record<string, HarnessClientSession[]>>({});
  const [collapsedProjects, setCollapsedProjects] = useState<string[]>(() => {
    try { const value = JSON.parse(localStorage.getItem("zhivex.code.drawer.v1") ?? "[]"); return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
    catch { return []; }
  });
  const [statusFilter, setStatusFilter] = useState(false);
  const [diffLayout, setDiffLayout] = useState<DiffLayoutPreference>(() => readDiffLayout(globalThis.localStorage?.getItem(DIFF_LAYOUT_KEY) ?? null));
  const [viewport, setViewport] = useState({ width: globalThis.innerWidth || 1440, height: globalThis.innerHeight || 900 });
  const [modelOpen, setModelOpen] = useState(false);
  const [mobilePane, setMobilePane] = useState<"chat" | "review">("chat");
  const [announce, setAnnounce] = useState("");
  const favoriteToggle = useRef<(() => void) | null>(null);
  const drawerButton = useRef<HTMLButtonElement>(null);
  const sessionLoads = useRef(new Set<string>());
  const jump = useRef<{ key: string; sessionId: string } | null>(null);
  const previousPosition = useRef<DiffPosition>("side");
  const selection = useRef({ workspaceKey: "", sessionId: "" });
  selection.current = { workspaceKey, sessionId: session?.sessionId ?? "" };
  function editPrompt(text: string) {
    drafts.current.edit(selection.current, text);
    setPrompt(text);
  }
  useEffect(() => {
    if (!workspaceKey) return;
    let stopped = false;
    void action<LimitsInfo>(workspaceKey, "limits").then(info => {
      if (!stopped) setLimitsInfo(info);
    }).catch(() => { if (!stopped) setLimitsError(limitsReadError); });
    void action<{ mode: ApprovalMode; records: ApprovalRecord[] }>(workspaceKey, "autoApprove", { sessionId: selection.current.sessionId }).then(info => {
      if (!stopped) { setApprovalMode(info.mode); setApprovalRecords(info.records); }
    }).catch(() => undefined);
    return () => { stopped = true; };
  }, [workspaceKey, refresh, run?.runId]);
  async function saveLimits(scope: LimitScope, settings: LimitSettings) {
    if (!limitsInfo || limitsSavingRef.current) return;
    limitsSavingRef.current = true;
    setLimitsSaving(true); setLimitsError("");
    try {
      await action(workspaceKey, "configureLimits", { scope, settings, expectedRevision: limitsInfo.preferences.revision });
      setLimitsInfo(await action<LimitsInfo>(workspaceKey, "limits"));
      setLimitsOpen(false);
    } catch {
      setLimitsError(limitsSaveError);
      setLimitsInfo(await action<LimitsInfo>(workspaceKey, "limits").catch(() => undefined));
    } finally { limitsSavingRef.current = false; setLimitsSaving(false); }
  }
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => setResolvedTheme(applyTheme(themeChoice, media.matches));
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [themeChoice]);
  useEffect(() => {
    if (viewport.width < NARROW_TABS && mobilePane === "review")
      document.getElementById("review-panel")?.focus();
  }, [mobilePane, viewport.width]);
  useEffect(() => {
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  useEffect(() => { setTitleDraft(session?.title ?? ""); }, [session?.sessionId, session?.title, session?.revision]);
  useEffect(() => {
    if (focusPrompt.current && session && !stateLoading && !pending) {
      focusPrompt.current = false;
      focusComposer();
    }
  }, [session, stateLoading, pending]);
  useEffect(() => {
    if (!review) return;
    reviewHeading.current?.focus();
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [review]);
  useEffect(() => {
    void context()
      .then((c) => {
        setContext(c);
        setWorkspaceKey(c.workspaces[0]?.key ?? "");
        setConnected(true);
      })
      .catch((e) => {
        setConnected(false);
        setError(errorText(e));
      });
  }, []);
  useEffect(() => {
    const timer = setInterval(() => {
      const epoch = contextEpoch.current;
      void reconnect().then(next => {
        if (epoch !== contextEpoch.current) return;
        setContext(previous => {
          const same = JSON.stringify(previous?.workspaces) === JSON.stringify(next.workspaces);
          return same && previous ? previous : { ...next, csrf: previous?.csrf ?? next.csrf };
        });
      }).catch(() => undefined);
    }, 2000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!workspaceKey) return;
    let stopped = false;
    setSessionsLoading(true);
    setSessions([]);
    setSession(undefined);
    setRun(undefined);
    setRunUnavailable(false);
    setReview(undefined);
    setActivity(emptyActivity());
    void action<Sessions>(workspaceKey, "sessions")
      .then((r) => {
        if (stopped) return;
        setSessions(r.data.sessions);
        setSessionsLoading(false);
        setConnected(true);
        const saved = localStorage.getItem(`zhivex-session:${workspaceKey}`);
        const chosen = r.data.sessions.find((s) => s.sessionId === saved) ?? r.data.sessions[0];
        setStateLoading(Boolean(chosen));
        setSession(chosen);
        setPrompt(drafts.current.read({ workspaceKey, sessionId: chosen?.sessionId ?? "" }).text);
      })
      .catch((e) => {
        if (!stopped) {
          setSessionsLoading(false);
          setConnected(false);
          setError(errorText(e));
        }
      });
    return () => {
      stopped = true;
    };
  }, [workspaceKey]);
  const sessionId = session?.sessionId;
  useEffect(() => {
    setReview(undefined);
    setRun(undefined);
    setRunLimits(null);
    setRunUnavailable(false);
    const empty = emptyActivity();
    activityRef.current = empty;
    setActivity(empty);
    setStateLoading(Boolean(workspaceKey && sessionId));
    setHasTask(false);
  }, [workspaceKey, sessionId]);
  useEffect(() => {
    if (!workspaceKey || !sessionId) return;
    localStorage.setItem(`zhivex-session:${workspaceKey}`, sessionId);
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const epoch = mutationEpoch.current;
      const obsolete = () => stopped || epoch !== mutationEpoch.current;
      try {
        const page = await action<HarnessActivityPage>(workspaceKey, "events", {
          sessionId,
          after: activityRef.current.cursor,
        });
        if (obsolete()) return;
        const next = applyActivityPage(activityRef.current, page);
        activityRef.current = next;
        setActivity(next);
        const result = await action<Session>(workspaceKey, "session", {
          sessionId,
        });
        if (obsolete()) return;
        setSession(result.data.session);
        setSessions((previous) =>
          previous.map((s) =>
            s.sessionId === result.data.session.sessionId
              ? result.data.session
              : s,
          ),
        );
        const latest = result.data.session.runs.at(-1);
        if (latest) {
          if (latest.runId !== runRef.current?.runId) {
            setStateLoading(true);
            setRun(undefined);
          }
          try {
            const detail = await action<Run>(workspaceKey, "run", {
              sessionId,
              runId: latest.runId,
            });
            if (obsolete()) return;
            setRun(detail.data.run);
            const thresholds = await action<RunLimits | null>(workspaceKey, "runLimits", { sessionId, runId: latest.runId });
            if (obsolete()) return;
            setRunLimits(thresholds);
            setRunUnavailable(false);
          } catch (e) {
            if (obsolete()) return;
            if (errorText(e) !== "NOT_FOUND") throw e;
            setRun(undefined);
            setRunUnavailable(true);
            setReview(undefined);
            setError("RUN_STATE_UNAVAILABLE");
          }
        }
        setStateLoading(false);
        setConnected(true);

        timer = setTimeout(() => void poll(), page.hasMore ? 20 : 650);
      } catch (e) {
        if (obsolete()) return;
        // A model switch briefly rejects reads. That is not a lost connection.
        if (errorText(e) === "WEB_MODEL_CHANGE_IN_PROGRESS") {
          timer = setTimeout(() => void poll(), 200);
          return;
        }
        setStateLoading(false);
        setConnected(false);
        setError(errorText(e));
        timer = setTimeout(() => void poll(), 2000);
      }
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [workspaceKey, sessionId, refresh]);
  const loading = sessionsLoading || stateLoading || (!ctx && !error);
  const busy =
    runUnavailable ||
    Boolean(run && (active(run.status) || run.status === "waiting_approval"));
  const canMutate = Boolean(
    ctx &&
      workspaceKey &&
      connected &&
      !loading &&
      !pending &&
      !cancelling &&
      !reconnecting &&
      !needsReconcile,
  );
  function chooseSession(next: HarnessClientSession) {
    setPrompt(drafts.current.read({ workspaceKey, sessionId: next.sessionId }).text);
    setSession(next);
  }
  async function perform(
    label: string,
    job: () => Promise<void>,
    mutation = false,
  ) {
    // React state is not a lock: two activations can arrive before the next render.
    if (inFlight.current || cancelInFlight.current || reconnectInFlight.current) return;
    inFlight.current = true;
    const cancellationsAtStart = recordedCancellations.current;
    mutationEpoch.current++;
    setError("");
    setPending(label);
    setRefresh((n) => n + 1);
    try {
      await job();
    } catch (e) {
      const code = errorText(e);
      // Cancel accepts the run while this start is still open. The host then
      // answers that start with EXECUTION_FAILED. The cancellation receipt is
      // the outcome, so this late failure must not cover it with an alert.
      const superseded = cancellationSupersedesFailure(
        code,
        cancelInFlight.current || recordedCancellations.current !== cancellationsAtStart,
      );
      if (!superseded) {
        setError(code);
        if (code === "WEB_REQUEST_FAILED") setConnected(false);
        // A confirmed terminal result, including EXECUTION_FAILED, stays editable.
        // Only a lost response locks the session, and it is never replayed.
        if (mutation && mutationUnconfirmed(code)) setNeedsReconcile(true);
      }
    } finally {
      mutationEpoch.current++;
      inFlight.current = false;
      setPending("");
      setRefresh((n) => n + 1);
    }
  }
  async function restoreConnection() {
    if (reconnectInFlight.current || cancelInFlight.current) return;
    reconnectInFlight.current = true;
    setReconnecting(true);
    setError("");
    try {
      let applied = false;
      for (let attempt = 0; attempt < 4 && !applied; attempt++) {
        // A failing command can still be settling. Wait for that receipt, then
        // read again so this reconnect is not discarded by its epoch bump.
        for (let wait = 0; inFlight.current && wait < 50; wait++) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const epoch = ++mutationEpoch.current;
        setRefresh((n) => n + 1);
        const c = await reconnect();
        const target = workspaceKey || c.workspaces[0]?.key;
        if (!target) throw new Error("WEB_WORKSPACE_REQUIRED");
        const list = await action<Sessions>(target, "sessions");
        const currentSession =
          list.data.sessions.find((s) => s.sessionId === sessionId) ??
          list.data.sessions[0];
        let detail: HarnessClientRun | undefined;
        let unavailable = false;
        if (currentSession?.runs.length) {
          try {
            detail = (
              await action<Run>(target, "run", {
                sessionId: currentSession.sessionId,
                runId: currentSession.runs.at(-1)!.runId,
              })
            ).data.run;
          } catch (e) {
            if (errorText(e) !== "NOT_FOUND") throw e;
            unavailable = true;
          }
        }
        // A command that finishes during the read bumps the epoch. Keep that
        // newer receipt and read once more. A command that is still active
        // does not invalidate this snapshot, so cancellation stays available.
        if (epoch !== mutationEpoch.current) continue;
        contextEpoch.current += 1;
        setContext(c);
        setWorkspaceKey(target);
        setSessions(list.data.sessions);
        setSession(currentSession);
        setRun(detail);
        setRunUnavailable(unavailable);
        setReview(undefined);
        setSessionsLoading(false);
        setStateLoading(false);
        setConnected(true);
        setNeedsReconcile(false);
        setError(unavailable ? "RUN_STATE_UNAVAILABLE" : "");
        applied = true;
      }
      if (!applied) {
        setConnected(false);
        setError("WEB_REQUEST_FAILED");
      }
    } catch (e) {
      setConnected(false);
      setError(errorText(e));
    } finally {
      mutationEpoch.current++;
      reconnectInFlight.current = false;
      setReconnecting(false);
      setRefresh((n) => n + 1);
    }
  }
  async function commitTitle() {
    const title = titleDraft.trim().slice(0, 96);
    if (!session || !canMutate || !title || title === session.title) return;
    await perform("Renaming session…", async () => {
      const result = await action<Session>(workspaceKey, "rename", {
        sessionId: session.sessionId,
        expectedRevision: session.revision,
        idempotencyKey: key(),
        title,
      });
      setSession(result.data.session);
      setSessions((previous) => previous.map((item) => item.sessionId === result.data.session.sessionId ? result.data.session : item));
    }, true);
  }
  async function create() {
    if (!canMutate) return;
    await perform(
      "Creating session…",
      async () => {
        const result = await action<Session>(workspaceKey, "create", {
          idempotencyKey: key(),
          title: "New session",
        });
        setSessions((previous) => [result.data.session, ...previous]);
        chooseSession(result.data.session);
        focusPrompt.current = true;
      },
      true,
    );
  }
  const noCredentials = !modelsLoading && modelChoices.length > 0 && !modelChoices.some((choice) => choice.configured);
  function focusComposer() {
    document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Task prompt"]')?.focus();
  }
  async function start(text?: string) {
    const input = text ?? prompt;
    const plan = planComposerSend({
      text: input,
      hasSession: Boolean(session),
      noCredentials,
      canSend: canMutate && !busy && !hasTask,
    });
    if (plan === "ignore" || plan === "need-credentials") {
      if (plan === "need-credentials") setError("WEB_CREDENTIALS_REQUIRED");
      return;
    }
    const selected = { workspaceKey, sessionId: session?.sessionId ?? "" };
    await perform(
      "Starting task…",
      async () => {
        // perform acquired its synchronous lock. Consume before any awaited
        // create/rename/start; completion must never clear a newer draft.
        const submitted = drafts.current.consume(selected);
        setPrompt("");
        let createdId = "";
        try {
          let current = session;
          if (!current) {
            const created = await action<Session>(workspaceKey, "create", {
              idempotencyKey: key(),
              title: "New session",
            });
            current = created.data.session;
            createdId = current.sessionId;
            setSessions((previous) => [current!, ...previous.filter((item) => item.sessionId !== current!.sessionId)]);
            setSession(current);
          }
          // A cancellation receipt can precede the final session-index update.
          // Read the selected session before its revision-bound dispatch. This
          // is reconciliation only; a rejected start is never replayed.
          let fresh = (await action<Session>(workspaceKey, "session", {
            sessionId: current.sessionId,
          })).data.session;
          if (!fresh.runs.length && fresh.title === "New session") {
            fresh = (
              await action<Session>(workspaceKey, "rename", {
                sessionId: fresh.sessionId,
                expectedRevision: fresh.revision,
                idempotencyKey: key(),
                title: input.trim().slice(0, 96),
              })
            ).data.session;
          }
          const result = await action<Run>(workspaceKey, "start", {
            sessionId: fresh.sessionId,
            expectedRevision: fresh.revision,
            idempotencyKey: key(),
            prompt: input,
          });
          const viewing = selection.current.sessionId === fresh.sessionId || selection.current.sessionId === selected.sessionId;
          if (selection.current.workspaceKey === workspaceKey && viewing) {
            setSession(result.data.session);
            setRun(result.data.run);
          }
        } catch (error) {
          drafts.current.failed(submitted);
          const kept = drafts.current.read(selected).text;
          const home = createdId ? { workspaceKey, sessionId: createdId } : selected;
          if (createdId) {
            drafts.current.edit(home, kept);
            const recovery = drafts.current.read(selected).recovery;
            if (recovery !== undefined) drafts.current.failed({ key: JSON.stringify([home.workspaceKey, home.sessionId]), text: recovery, consumedVersion: -1 });
          }
          if (selection.current.workspaceKey === workspaceKey &&
              (selection.current.sessionId === selected.sessionId || selection.current.sessionId === createdId))
            setPrompt(drafts.current.read(home).text);
          throw error;
        }
      },
      true,
    );
  }
  async function loadReview() {
    if (!session || !run || !canMutate || run.status !== "waiting_approval")
      return;
    const selected = selection.current;
    await perform("Loading exact review…", async () => {
      // Start the local cutoff before the host issues its five-minute ticket.
      const deadline = Date.now() + 5 * 60_000;
      const r = await action<TicketedApprovalReview & { autoApproved?: boolean; data?: { session?: HarnessClientSession; run?: HarnessClientRun }; records?: ApprovalRecord[] }>(workspaceKey, "review", {
        sessionId: session.sessionId,
        runId: run.runId,
      });
      if (r.autoApproved) {
        if (selection.current.workspaceKey === selected.workspaceKey && selection.current.sessionId === selected.sessionId) {
          if (r.data?.session) setSession(r.data.session);
          if (r.data?.run) setRun(r.data.run);
          if (r.records) setApprovalRecords(r.records);
          setReview(undefined);
          setAnnounce("Auto-approved this change. Press m for Manual. Undo is in Approvals.");
        }
        return;
      }
      if (
        selection.current.workspaceKey === selected.workspaceKey &&
        selection.current.sessionId === selected.sessionId
      ) {
        setNow(Date.now());
        setReviewDeadline(deadline);
        setReview(r);
      }
    });
  }
  useEffect(() => {
    if (run?.status !== "waiting_approval" || review || !canMutate) return;
    if (diffLayout.minimized) {
      setAnnounce("A review needs you. Restore the review to decide.");
      return;
    }
    void loadReview();
  }, [run?.status, run?.runId, run?.revision, canMutate, review, diffLayout.minimized]);
  const reviewInvalid = review
    ? !run ||
      review.runId !== run.runId ||
      review.revision !== run.revision ||
      run.status !== "waiting_approval"
      ? "The run changed. Load a fresh review before deciding."
      : now >= reviewDeadline || review.items.some((i) => i.expiresAt <= now)
        ? "This review expired. Load a fresh review before deciding."
        : !connected || needsReconcile
          ? "Reconnect to read the current state before deciding."
          : ""
    : "";
  async function decide(approve: boolean) {
    if (
      !review ||
      !canMutate ||
      reviewInvalid ||
      Date.now() >= reviewDeadline ||
      review.items.some((i) => i.expiresAt <= Date.now()) ||
      (approve && (!review.canApprove || !viewed.allViewed))
    )
      return;
    const ticket = review.ticketId;
    setReview(undefined);
    await perform(
      approve ? "Submitting approval…" : "Submitting denial…",
      async () => {
        const result = await action<Run>(workspaceKey, "decide", {
          ticketId: ticket,
          approve,
        });
        setSession(result.data.session);
        setRun(result.data.run);
      },
      true,
    );
  }
  const canCancel = Boolean(
    session &&
      run &&
      connected &&
      !loading &&
      !needsReconcile &&
      !cancelling &&
      !reconnecting &&
      run.status !== "cancel_requested" &&
      (active(run.status) || run.status === "waiting_approval") &&
      (!pending ||
        [
          "Starting task…",
          "Submitting approval…",
          "Submitting denial…",
        ].includes(pending)),
  );
  async function cancel() {
    // The host keeps start/decision responses open while working. Cancellation
    // must use its independent active-run control path during those requests.
    if (!session || !run || !canCancel || cancelInFlight.current || reconnectInFlight.current) return;
    cancelInFlight.current = true;
    setCancelling(true);
    setReview(undefined);
    setError("");
    mutationEpoch.current++;
    setRefresh((n) => n + 1);
    try {
      const result = await action<Run>(workspaceKey, "cancel", {
        sessionId: session.sessionId,
        runId: run.runId,
        expectedRevision: run.revision,
        idempotencyKey: key(),
      });
      setSession(result.data.session);
      setRun(result.data.run);
      if (result.data.run.status === "cancelled" || result.data.run.status === "cancel_requested")
        recordedCancellations.current += 1;
    } catch (e) {
      const code = errorText(e);
      setError(code);
      if (code === "WEB_REQUEST_FAILED") setConnected(false);
      if (mutationUnconfirmed(code)) setNeedsReconcile(true);
    } finally {
      mutationEpoch.current++;
      cancelInFlight.current = false;
      setCancelling(false);
      setRefresh((n) => n + 1);
    }
  }
  const workspace = ctx?.workspaces.find((w) => w.key === workspaceKey);
  const currentModel = workspace?.provider && workspace.model ? choiceKey({ provider: workspace.provider, model: workspace.model }) : "";
  useEffect(() => {
    if (!workspaceKey || !connected) return;
    let stopped = false;
    setModelChoices([]); setModelError(""); setModelSelectionError(""); setModelsLoading(true);
    void action<{choices: WebModelChoice[]}>(workspaceKey, "models")
      .then(result => { if (!stopped) setModelChoices(result.choices); })
      .catch(error => { if (!stopped) setModelError(errorText(error)); })
      .finally(() => { if (!stopped) setModelsLoading(false); });
    return () => { stopped = true; };
  }, [workspaceKey, connected, currentModel, ctx]);
  async function selectModelChoice(provider: string, model: string) {
    if (!canMutate || busy || review || choiceKey({ provider, model }) === currentModel) return;
    setModelSelectionError("");
    await perform("Applying model for future tasks…", async () => {
      try {
        await action(workspaceKey, "selectModel", {provider, model});
      } catch (error) {
        // This response belongs to model admission, not the later context read.
        // Definitive pre-change rejection leaves navigation/cancel available.
        if (error instanceof ModelSelectionRejectedError) {
          const reasons: Record<string, string> = {
            WEB_MODEL_CHANGE_BUSY: "Finish or cancel active work in this workspace before changing the model.",
            WEB_MODEL_CHANGE_IN_PROGRESS: "Another model change is in progress; try again once it finishes.",
            WEB_MODEL_NOT_CONFIGURED: "That provider and model are no longer configured on the host. Choose another option.",
            WEB_CREDENTIALS_REQUIRED: "Configure the provider credentials on the host before trying again.",
          };
          setModelSelectionError(`Model unchanged. ${reasons[error.message] ?? "The host rejected this selection."}`);
          return;
        }
        throw error;
      }
      setReview(undefined);
      const c = await reconnect();
      contextEpoch.current += 1;
      setContext(c);
      setRefresh(n => n + 1);
    }, true);
  }
  function saveDiff(next: DiffLayoutPreference) {
    setDiffLayout(next);
    localStorage.setItem(DIFF_LAYOUT_KEY, JSON.stringify(next));
  }
  function resetDiffSize() {
    saveDiff({ ...diffLayout, widthPx: defaultDiffLayout().widthPx, heightPx: defaultDiffLayout().heightPx });
  }
  useEffect(() => {
    if (!workspaceKey || !connected) return;
    let stopped = false;
    const load = () => {
      void action<{ projects: WebProjectOverview[] }>(workspaceKey, "overview").then(result => {
        if (!stopped) setOverview(result.projects);
      }).catch(() => undefined);
    };
    load();
    const timer = setInterval(load, 3000);
    return () => { stopped = true; clearInterval(timer); };
  }, [workspaceKey, connected, refresh]);
  useEffect(() => {
    const target = jump.current;
    if (!target || target.key !== workspaceKey || sessionsLoading) return;
    const found = sessions.find(sessionItem => sessionItem.sessionId === target.sessionId);
    if (!found) return;
    jump.current = null;
    chooseSession(found);
    setDrawerOpen(false);
  }, [workspaceKey, sessions, sessionsLoading]);
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.key === "m" || event.key === "M") && !event.metaKey && !event.ctrlKey && !event.altKey && !isTextField(event.target) && !modelOpen && !limitsOpen && !approvalOpen && approvalMode !== "manual") {
        event.preventDefault();
        void action(workspaceKey, "setAutoApprove", { scope: "session", mode: "manual", sessionId: session?.sessionId ?? "" }).then(() => {
          setApprovalMode("manual");
          setAnnounce("Approvals are manual for this session.");
        }).catch(() => setError("Could not switch approvals to Manual."));
        return;
      }
      if (event.key === "Escape") {
        if (modelOpen) { setModelOpen(false); return; }
        if (drawerOpen) { setDrawerOpen(false); drawerButton.current?.focus(); return; }
        if (addProjectOpen) { setAddProjectOpen(false); return; }
        if (effectiveDiffPosition(diffLayout.position, viewport.width) === "full" && !diffLayout.minimized) {
          saveDiff({ ...diffLayout, position: previousPosition.current });
          return;
        }
        if (document.getElementById("review-panel")?.contains(document.activeElement)) focusComposer();
        return;
      }
      const actionName = altShiftAction(event);
      if (!actionName) return;
      if (actionName === "favorite") { event.preventDefault(); favoriteToggle.current?.(); return; }
      if (actionName === "model") {
        if (isTextField(event.target) || run?.status === "waiting_approval") return;
        event.preventDefault();
        setModelOpen(true);
        return;
      }
      if (isTextField(event.target) && actionName !== "approve" && actionName !== "reject") return;
      if (actionName === "drawer") { event.preventDefault(); setDrawerOpen(open => !open); return; }
      if (actionName === "session") { event.preventDefault(); if (canMutate) void create(); return; }
      if (actionName === "minimize") { event.preventDefault(); saveDiff({ ...diffLayout, minimized: !diffLayout.minimized }); return; }
      if (actionName === "position") {
        event.preventDefault();
        const current = effectiveDiffPosition(diffLayout.position, viewport.width);
        if (current !== "full") previousPosition.current = current;
        saveDiff({ ...diffLayout, position: nextDiffPosition(current, viewport.width), minimized: false });
        return;
      }
      const reviewFocused = document.getElementById("review-panel")?.contains(document.activeElement);
      if (!reviewFocused || diffLayout.minimized) return;
      event.preventDefault();
      if (actionName === "approve") document.querySelector<HTMLButtonElement>("[data-decision='approve']:enabled")?.click();
      if (actionName === "reject") document.querySelector<HTMLButtonElement>("[data-decision='reject']:enabled")?.click();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const stateLabel = loading
    ? "Loading…"
    : !connected
      ? "Not connected"
      : needsReconcile
        ? "Refresh needed"
        : runUnavailable
          ? "Couldn't read this run"
          : run
            ? runStatusLabel(run.status)
            : error
              ? "Error"
              // A mutation still in flight is not a settled idle session. Callers
              // that wait for Ready must not continue on the session being replaced.
              : pending
                ? "Working…"
                : "Ready";
  const composerHelp = needsReconcile
    ? "The last response did not arrive. Choose Reconcile to reload this session. Nothing is sent again on its own."
    : !connected
      ? "The connection dropped. Work already admitted may still be running. Choose Reconcile to reload."
      : loading
        ? "Reading this session before actions are available."
        : runUnavailable
          ? statusCopy("RUN_STATE_UNAVAILABLE").next
          : noCredentials
            ? statusCopy("WEB_CREDENTIALS_REQUIRED").next
          : run?.status === "waiting_approval"
            ? "Review the proposed change, or cancel this run. Your next draft stays here."
            : run?.status === "cancel_requested"
              ? "Stop requested. Waiting for the host to confirm."
              : run?.status === "failed" || error
                ? error ? statusCopy(error).next : "This task stopped. Edit the message and send it again."
              : busy
                ? "Work is running. You can prepare the next message or stop this run."
                : "Describe a task. The first message starts a session in this workspace.";
  const tools = Object.values(activity.runs).flatMap((r) =>
    Object.values(r.tools ?? {}).map((tool) => ({
      ...tool,
      status:
        tool.status === "running"
          ? r.status === "waiting_approval"
            ? "Needs you"
            : active(r.status)
              ? "Running"
              : "Not finished"
          : tool.status,
    })),
  );
  const checks = tools.filter((t) => t.name === "run_check");
  const position = effectiveDiffPosition(diffLayout.position, viewport.width);
  const reviewWaiting = run?.status === "waiting_approval";
  const emptyReview = !reviewWaiting;
  const narrow = viewport.width < NARROW_TABS;
  const diffWidth = emptyReview || diffLayout.minimized ? EMPTY_DIFF_WIDTH : clampDiffWidth(diffLayout.widthPx, viewport.width);
  const diffHeight = clampDiffHeight(diffLayout.heightPx, viewport.height);
  const remaining = Math.max(0, reviewDeadline - now);
  const expiresLabel = `${Math.floor(remaining / 60000)}:${String(Math.floor((remaining / 1000) % 60)).padStart(2, "0")}`;
  const projects: DrawerProject[] = (ctx?.workspaces ?? []).map(item => ({
    ...item,
    pending: overview.find(project => project.key === item.key)?.pending.filter(() => !item.unavailable).length ?? 0,
  }));
  const grouped = projects.length > 1;
  const pendingItems = overview.flatMap(project => project.unavailable ? [] : project.pending.map(item => ({ ...item, key: project.key })));
  pendingItems.sort((a, b) => (a.expiresAt ?? Number.MAX_SAFE_INTEGER) - (b.expiresAt ?? Number.MAX_SAFE_INTEGER));
  const collapsed = new Set(grouped ? projects.filter(project => project.key !== workspaceKey && project.pending === 0 && (collapsedProjects.includes(project.key) || collapsedProjects.length === 0)).map(project => project.key) : []);
  const sessionMap: Record<string, HarnessClientSession[] | undefined> = { ...extraSessions };
  if (workspaceKey) sessionMap[workspaceKey] = sessionsLoading ? undefined : sessions;
  const connectionLabel = !connected ? "Not connected" : needsReconcile ? "Refresh needed" : "Connected";
  const approvalLabel = approvalMode === "auto-edits" ? "Auto-edits" : approvalMode === "auto-limits" ? "Auto-limits" : "Manual";
  const limitsLabel = limitsInfo && Object.values(limitsInfo.preferences.task ?? limitsInfo.preferences.project).some(threshold => threshold.value !== null)
    ? `Limits for ${limitsInfo.preferences.task ? "the next task" : "the project"}`
    : limitsInfo && Object.values(limitsInfo.host).some(value => value !== null) ? "Default budgets" : "No limits configured";
  const failureCopy = error ? statusCopy(error) : undefined;
  const canSwitch = !cancelling && !reconnecting && !needsReconcile && !pending;
  const currentChoice = modelChoices.find(choice => choiceKey(choice) === currentModel);
  function openPending(items = pendingItems) {
    if (items.length === 1) {
      const item = items[0]!;
      jump.current = { key: item.key, sessionId: item.sessionId };
      saveDiff({ ...diffLayout, minimized: false });
      if (item.key !== workspaceKey) setWorkspaceKey(item.key);
      else {
        const found = sessions.find(sessionItem => sessionItem.sessionId === item.sessionId);
        if (found) chooseSession(found);
      }
      setDrawerOpen(false);
      return;
    }
    if (items.length > 1) {
      setStatusFilter(true);
      setDrawerOpen(true);
    }
  }
  function loadProjectSessions(key: string) {
    if (!key || key === workspaceKey || extraSessions[key] || sessionLoads.current.has(key)) return;
    sessionLoads.current.add(key);
    void action<Sessions>(key, "sessions").then(result => {
      setExtraSessions(current => current[key] ? current : { ...current, [key]: result.data.sessions });
    }).catch(() => undefined).finally(() => { sessionLoads.current.delete(key); });
  }
  function toggleProject(key: string) {
    setCollapsedProjects(previous => {
      const seeded = previous.length ? previous : projects.filter(project => project.key !== workspaceKey && project.pending === 0).map(project => project.key);
      const next = seeded.includes(key) ? seeded.filter(item => item !== key) : [...seeded, key];
      localStorage.setItem("zhivex.code.drawer.v1", JSON.stringify(next));
      return next;
    });
    loadProjectSessions(key);
  }
  const expandedOtherProjects = projects
    .filter(project => project.key !== workspaceKey && !project.unavailable && !collapsed.has(project.key))
    .map(project => project.key)
    .sort()
    .join("\n");
  useEffect(() => {
    if (!drawerOpen) return;
    for (const key of expandedOtherProjects.split("\n")) loadProjectSessions(key);
  }, [drawerOpen, expandedOtherProjects]);
  const frameStyle = { "--diff-width": `${diffWidth}px`, "--diff-height": `${diffHeight}px` } as CSSProperties;
  return (
    <div className="app-shell" data-theme={resolvedTheme}>
      <a className="skip-link" href="#task-workspace">Skip to task workspace</a>
      <header className="topbar">
        <a href="/" className="brand" aria-label="Zhivex Code home">
          <img className="brand-mark" src="/zhivex-icon.png" alt="" width={28} height={28} />
          <span>ZHIVEX</span>
        </a>
        <div className="crumb">
          {grouped ? <button type="button" className="project-switch" aria-haspopup="dialog" onClick={() => { setDrawerOpen(true); setStatusFilter(false); }}>
            {workspace?.name ?? "Project"} <span aria-hidden="true">▾</span>
          </button> : <span className="project-crumb">{workspace?.name ?? "Project"}</span>}
          <span className="crumb-sep" aria-hidden="true">/</span>
          {session ? <input className="session-title" aria-label="Session title" value={titleDraft} maxLength={96}
            disabled={!canMutate} onChange={event => setTitleDraft(event.target.value)}
            onBlur={() => void commitTitle()}
            onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }} />
            : <span className="session-title-static">New session</span>}
        </div>
        <div className="topbar-status">
          {loading ? <span className="connection-label">Reading…</span>
            : !connected ? <button type="button" className="connection-action" disabled={reconnecting || cancelling} onClick={() => void restoreConnection()}>Reconnect</button>
            : needsReconcile || error ? <button type="button" className="connection-action" disabled={reconnecting || cancelling} onClick={() => void restoreConnection()}>Reconcile</button>
            : pendingItems.length > 0 ? <button type="button" className="needs-you-count" onClick={() => openPending()}>
              {pendingItems.length === 1 ? "1 needs you" : `${pendingItems.length} need you`}
            </button>
            : <span className="connection-label"><span className="status-dot" aria-hidden="true" />{connectionLabel}</span>}
          <button type="button" className="subtle topbar-chip approval-mode" aria-label={`Approvals: ${approvalLabel}. Press m for Manual.`} title="Approvals. Press m for Manual." onClick={() => setApprovalOpen(true)}>{approvalLabel}</button>
        </div>
        <div className="topbar-actions">
          <button ref={drawerButton} type="button" className="subtle topbar-chip" aria-expanded={drawerOpen} onClick={() => { setDrawerOpen(open => !open); setStatusFilter(false); }}>Sessions</button>
          <button className="limits-launcher topbar-chip" aria-label={limitsLabel} title={limitsLabel} disabled={!workspaceKey || !connected || !limitsInfo || limitsInfo.workspaceKey !== workspaceKey || needsReconcile}
            onClick={() => { setLimitsError(""); setLimitsOpen(true); }}>
            <SlidersHorizontalIcon size={16} /><span>{limitsLabel}</span>
          </button>
          <button type="button" className="icon-button topbar-icon" aria-label="New session" disabled={!canMutate} onClick={() => void create()}><PlusIcon size={16} /></button>
          <button type="button" className="icon-button topbar-icon" aria-label={`Theme ${themeChoice}. Switch theme`} onClick={() => {
            const next: ThemeChoice = themeChoice === "system" ? "light" : themeChoice === "light" ? "dark" : "system";
            localStorage.setItem(THEME_KEY, next);
            setThemeChoice(next);
          }}>{themeChoice === "system" ? <DesktopIcon size={16} /> : resolvedTheme === "dark" ? <MoonIcon size={16} /> : <SunIcon size={16} />}</button>
        </div>
      </header>
      {failureCopy && <div role="alert" className="error-banner">
        <strong>{failureCopy.title}</strong>
        <span>{failureCopy.next}</span>
        {failureCopy.detail ? <span className="error-detail">{failureCopy.detail}</span> : null}
        <button className="subtle" aria-label="Dismiss error" onClick={() => setError("")}>×</button>
      </div>}
      {(pending || cancelling || reconnecting) && <div className="operation-status" role="status">
        {reconnecting ? "Reading durable state…" : cancelling ? "Requesting cancellation…" : pending === "Starting task…" && run && active(run.status) ? "Task admitted. Following host activity…" : pending}
      </div>}
      {narrow && <div className="pane-tabs" role="tablist" aria-label="Workspace sections">
        <button type="button" role="tab" aria-selected={mobilePane === "chat"} onClick={() => setMobilePane("chat")}>Chat</button>
        <button type="button" role="tab" aria-selected={mobilePane === "review"} onClick={() => setMobilePane("review")}>Review</button>
      </div>}
      <div id="task-workspace" className="workspace-frame" data-position={diffLayout.minimized ? "minimized" : position} data-empty={emptyReview ? "true" : "false"} data-pane={narrow ? mobilePane : "both"} style={frameStyle} tabIndex={-1}>
        <section className="chat-column">
          <ChatRoot className="conversation" label="Task stream" theme={resolvedTheme}>
            <div className="section-heading"><span>Task stream</span><span className={`pill ${reviewWaiting ? "attention" : run?.status === "failed" || !connected || needsReconcile || runUnavailable || Boolean(error) ? "warning" : ""}`}>{stateLabel}</span></div>
            <p className="state-guidance" id="composer-help">{composerHelp}</p>
            {sessionsLoading && <p className="session-empty" role="status">Loading sessions…</p>}
            {runLimits && <div className="run-limits-summary" aria-label="Limits for the current task">
              <span>{runLimits.origin === "task" ? "Limits for this task" : runLimits.origin === "project" ? "Project limits" : "Default budgets"}. {counted(runLimits.consumption.steps, "step")} · {counted(runLimits.consumption.toolCalls, "tool call")} · {counted(runLimits.consumption.tokens, "token")}.</span>
              <div className="budget-meters">
                {(["toolCalls", "tokens", "steps", "durationMinutes"] as const).map(name => {
                  const max = runLimits.settings[name].value ?? limitsInfo?.host[name] ?? null;
                  const used = runLimits.consumption[name];
                  if (max === null || used === null) return null;
                  const label = name === "toolCalls" ? "Tool calls" : name === "durationMinutes" ? "Minutes" : name === "tokens" ? "Tokens" : "Steps";
                  return <label key={name} className="budget-meter">{label}<progress value={Math.min(used, max)} max={max} />{name === "durationMinutes" ? used.toFixed(1) : Math.round(used)} / {max}</label>;
                })}
              </div>
              <p className="muted">Read-only tools count toward these budgets. Long conversations are compacted automatically. Choose Stop to cancel; recorded work stays.</p>
              <details><summary>View thresholds for this task</summary>
                <p>Estimated spend: {runLimits.consumption.costUsd === null ? "unavailable" : `$${runLimits.consumption.costUsd.toFixed(6)}`} · Active duration: {runLimits.consumption.durationMinutes.toFixed(2)} min.</p>
                {Object.entries(runLimits.settings).filter(([, threshold]) => threshold.value !== null).map(([name, threshold]) => <p key={name}>
                  {({ costUsd: "Estimated spend (USD)", tokens: "Tokens", steps: "Steps", toolCalls: "Tools", durationMinutes: "Duration (min)" } as Record<string, string>)[name]}: {threshold.value} · {threshold.action === "notify" ? "Notify" : "Stop"}.
                </p>)}
                {runLimits.pricing && <p>Advisory price: {runLimits.pricing.source}. The estimate can exceed the threshold; it is not a guaranteed financial cap.</p>}
              </details>
              {runLimits.observationError && <p role="alert">Usage could not be tracked reliably. Choose Reconcile, then check this task. Limits may not have been applied.</p>}
              {runLimits.notices.map(notice => <p key={notice.name} role="status">
                {({ costUsd: "Estimated spend", tokens: "Tokens", steps: "Steps", toolCalls: "Tool calls", durationMinutes: "Time" })[notice.name]} reached {notice.actual.toFixed(notice.name === "costUsd" || notice.name === "durationMinutes" ? 2 : 0)} of {notice.threshold}.
                {notice.action === "notify" ? " The task can continue." : runLimits.cancellationRequested ? " Stop requested. Recorded work is kept. Send a new message to continue." : " The task had already finished."}
              </p>)}
            </div>}
            {hasTask && <a className="task-jump subtle" href="#task-evidence">View task and evidence</a>}
            <div className="messages" role="log" aria-label="Run activity" aria-live="off">
              {!activity.order.length && loading && <p className="loading-state" role="status">Loading durable activity…</p>}
              {!activity.order.length && !loading && connected && !session?.runs.length && <div className="empty-state">
                <img className="workspace-glyph" src="/zhivex-icon.png" alt="" width={56} height={56} />
                <p className="eyebrow">YOUR CODE. YOUR WORKSPACE.</p>
                <ChatEmptyState title="What are we building?" description="Start a task, follow the work, and review each operation that needs your approval."
                  starterPrompts={["Inspect this project and suggest a focused improvement", "Explain the architecture and existing checks", "Review the current changes for potential issues"]}
                  onStarterPrompt={text => { editPrompt(text); void start(text); }} />
              </div>}
              {activity.order.map(id => {
                const retained = activity.runs[id]!;
                const item = runUnavailable && session?.runs.at(-1)?.runId === id ? { ...retained, status: "state unavailable" } : retained;
                return <div className="turn" key={id}>
                  {item.prompt && <Message showActions={false} showStatus={false} message={{ id: `user-${id}`, role: "user", parts: [{ type: "text", text: item.prompt }], createdAt: 0, status: "complete" }} />}
                  <article className="assistant-response" aria-label="Assistant response" aria-busy={active(item.status)}>
                    <MessageMarkdown text={item.text || (item.status === "waiting_approval" ? "The proposed operation is ready for your review." : active(item.status) ? "Working in your local workspace…" : (item.status === "failed" && run?.runId === id ? providerStreamFailureText(run.error?.providerDiagnostic) : undefined) ?? "No text output recorded.")} />
                  </article>
                  {item.truncated && <p className="muted">Retained output is truncated.</p>}
                  <div className="turn-footer"><span>{runStatusLabel(item.status === "state unavailable" ? undefined : item.status)}</span></div>
                  <details className="technical-details"><summary>Technical details</summary><p>Run {id}</p></details>
                </div>;
              })}
              {activity.recovered && <p className="recovery-note">Earlier messages were restored from the saved session.</p>}
            </div>
            {reviewWaiting && run && <ReviewCard reviewId={`${run.runId}:${run.revision}`} heading="Change review" description="Use the change review panel to approve or reject. Approval stays off until every file has been viewed." />}
            {workspace && session && <TaskPanel key={[workspace.key, session.sessionId, workspace.taskProtocol?.connectionId].join(":")}
              workspace={workspace} session={session} {...(run ? { run } : {})} enabled={canMutate} connected={connected && !needsReconcile}
              prompt={prompt} perform={perform} onTask={setHasTask} onResult={(data) => {
                if (data.kind === "run") { setRun(data.run); setSession(data.session); }
                setRefresh(n => n + 1);
              }} />}
            {!tools.length ? null : <ul className="tool-list" aria-label="Activity and checks">
              {groupToolRows(tools).map((group, index) => group.kind === "explore" ? <li key={index}>
                <details className="explore-group">
                  <summary>Explored {group.count} {group.count === 1 ? "file" : "files"}</summary>
                  <ul>{group.tools.map((tool, toolIndex) => <li key={toolIndex}>{human(tool.name)} · {tool.status}</li>)}</ul>
                </details>
              </li> : <li key={index}><strong>{human(group.tool.name)}</strong><small>{group.tool.exitCode === undefined ? group.tool.status : `exit ${group.tool.exitCode}${group.tool.timedOut ? " · timed out" : ""}`}</small></li>)}
            </ul>}
            {checks.length > 0 && <p className="check-summary">{checks.filter(check => check.exitCode === 0 && !check.timedOut).length}/{checks.length} checks passed</p>}
            {diffLayout.minimized && <div className="restore-bar" role="status">
              <span>{reviewWaiting ? `Needs you · ${viewed.approveLabel.replace(/^Approve /, "")} · Expires in ${expiresLabel}` : "Review is minimized"}</span>
              <button type="button" onClick={() => saveDiff({ ...diffLayout, minimized: false })}>Restore review</button>
            </div>}
            <Composer className="composer" value={prompt} onValueChange={editPrompt} onSend={value => { void start(value); }} onStop={() => { void cancel(); }}
              status={active(run?.status ?? "") || cancelling || reviewWaiting ? "streaming" : "ready"} allowAttachments={false}
              labels={{ inputLabel: "Task prompt", send: "Send composer", stop: run?.status === "cancel_requested" ? "Stop requested" : cancelling ? "Requesting cancellation…" : "Cancel run", inputPlaceholder: "Describe a task for this workspace…" }}
              textareaProps={{ "aria-describedby": "composer-help", maxLength: 65536, disabled: cancelling || loading || (Boolean(pending) && pending !== "Starting task…" && !busy) }}
              trailingActions={<button type="button" className="primary" disabled={!prompt.trim() || !canMutate || hasTask || Boolean(run && (active(run.status) || run.status === "waiting_approval"))} onClick={() => void start()}>{hasTask ? "Use task review to continue" : "Run task"}</button>}
              leadingActions={<ModelPicker workspaceKey={workspaceKey} choices={modelChoices} currentKey={currentModel} currentLabel={currentChoice ? `${currentChoice.name} · ${currentChoice.providerName}` : `${workspace?.model ?? "Host model"} · ${workspace?.provider ?? "Host"}`}
                configured={currentChoice ? currentChoice.configured : true} disabled={!canMutate || busy || reviewWaiting} pendingReview={reviewWaiting} loading={modelsLoading}
                unavailable={Boolean(modelError)} selectionError={modelSelectionError} open={modelOpen} onOpenChange={setModelOpen}
                onApply={choice => void selectModelChoice(choice.provider, choice.model)} favoriteToggle={favoriteToggle} />} />
            <div className="composer-note"><span>Enter to send · Shift+Enter for a new line</span><span>Credentials stay on the host</span></div>
            {drafts.current.read(selection.current).recovery !== undefined && <div className="composer-recovery" role="status">
              <p>{prompt.trim()
                ? "This message did not finish. It is still in the composer. Change it if you need to, then choose Send again. It is not sent on its own."
                : "This message did not finish. Choose Edit message to put it back, then Send again. It is not sent on its own."}</p>
              <pre>{drafts.current.read(selection.current).recovery}</pre>
              <button type="button" disabled={Boolean(prompt)} onClick={() => { if (drafts.current.recover(selection.current)) { setPrompt(drafts.current.read(selection.current).text); focusComposer(); } }}>Edit message</button>
              <button type="button" disabled={!prompt.trim() || !canMutate || busy} onClick={() => void start()}>Send again</button>
            </div>}
          </ChatRoot>
        </section>
        {!diffLayout.minimized && position !== "full" && !emptyReview && <div role="separator" className="diff-handle" tabIndex={0}
          aria-orientation={position === "side" ? "vertical" : "horizontal"}
          aria-valuenow={position === "side" ? diffWidth : diffHeight}
          aria-valuemin={position === "side" ? DIFF_MIN_WIDTH : DIFF_MIN_HEIGHT}
          aria-valuemax={position === "side" ? maxDiffWidth(viewport.width) : maxDiffHeight(viewport.height)}
          aria-label={position === "side" ? "Diff width" : "Diff height"}
          title={`${position === "side" ? diffWidth : diffHeight} px. Minimum ${position === "side" ? DIFF_MIN_WIDTH : DIFF_MIN_HEIGHT}. Maximum ${position === "side" ? maxDiffWidth(viewport.width) : maxDiffHeight(viewport.height)}.`}
          onPointerDown={event => {
            if (event.pointerType === "mouse" && event.button !== 0) return;
            event.preventDefault();
            const handle = event.currentTarget;
            const pointerId = event.pointerId;
            const horizontal = position === "side";
            const origin = horizontal ? event.clientX : event.clientY;
            const initial = horizontal ? diffWidth : diffHeight;
            const layout = diffLayout;
            const viewportWidth = viewport.width;
            const viewportHeight = viewport.height;
            handle.setPointerCapture(pointerId);
            const move = (ev: PointerEvent) => {
              const delta = (horizontal ? ev.clientX : ev.clientY) - origin;
              const next = initial - delta;
              if (horizontal) saveDiff({ ...layout, widthPx: clampDiffWidth(next, viewportWidth) });
              else saveDiff({ ...layout, heightPx: clampDiffHeight(next, viewportHeight) });
            };
            const finish = () => {
              if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
              handle.removeEventListener("pointermove", move);
              handle.removeEventListener("pointerup", finish);
              handle.removeEventListener("pointercancel", finish);
            };
            handle.addEventListener("pointermove", move);
            handle.addEventListener("pointerup", finish);
            handle.addEventListener("pointercancel", finish);
          }}
          onDoubleClick={() => resetDiffSize()}
          onKeyDown={event => {
            if (event.key === "Enter") { event.preventDefault(); resetDiffSize(); return; }
            const horizontal = position === "side";
            const keys = horizontal ? ["ArrowLeft", "ArrowRight", "Home", "End"] : ["ArrowUp", "ArrowDown", "Home", "End"];
            if (!keys.includes(event.key)) return;
            event.preventDefault();
            if (horizontal) saveDiff({ ...diffLayout, widthPx: nudgeDiffSize(diffWidth, event.key, event.shiftKey, DIFF_MIN_WIDTH, maxDiffWidth(viewport.width)) });
            else saveDiff({ ...diffLayout, heightPx: nudgeDiffSize(diffHeight, event.key, event.shiftKey, DIFF_MIN_HEIGHT, maxDiffHeight(viewport.height)) });
          }}><span /></div>}
        {!diffLayout.minimized && <aside className="diff-column" id="review-panel" tabIndex={-1} aria-label="Pending review">
          <div className="review-toolbar">
            <h2 id="review-heading" ref={reviewHeading} tabIndex={-1}>{workspace?.name ?? "Project"} · Change review</h2>
            <div role="radiogroup" aria-label="Review position">
              {(["side", "bottom", "full"] as const).map(value => <button key={value} type="button" role="radio" aria-checked={diffLayout.position === value}
                disabled={value === "side" && !sideFits(viewport.width)} className={value === "side" && !sideFits(viewport.width) ? "struck" : undefined}
                onClick={() => { if (position !== "full") previousPosition.current = position; saveDiff({ ...diffLayout, position: value, minimized: false }); }}>{value === "side" ? "Side" : value === "bottom" ? "Bottom" : "Fullscreen"}</button>)}
            </div>
            <button type="button" onClick={() => saveDiff({ ...diffLayout, minimized: !diffLayout.minimized })}>{diffLayout.minimized ? "Restore" : "Minimize"}</button>
            {position === "full" && <button type="button" onClick={() => saveDiff({ ...diffLayout, position: previousPosition.current === "full" ? "side" : previousPosition.current })}>Exit fullscreen</button>}
          </div>
          {diffLayout.position === "side" && !sideFits(viewport.width) && <p className="layout-note">Side by side does not fit this window. The review moves below the chat. Your saved preference returns when the window is wider.</p>}
          {reviewWaiting ? <div className="review-content" aria-label="Approval review">
            <button type="button" className="subtle" disabled={!canMutate} onClick={() => void loadReview()}>{review ? "Reload review" : "Reload review"}</button>
            {reviewInvalid && <p className="restriction" role="status">{reviewInvalid}</p>}
            {review && <>
              <p className="review-scope">{workspace?.name}: {viewed.approveLabel.replace(/^Approve /, "Covers ")}. Expires in {expiresLabel}.</p>
              <p>{reviewConsequence}</p>
              {review.items.map(item => <article key={item.approvalId}>
                <h3 className="review-operation">{human(item.name)}</h3>
                <p>{item.consequence}</p>
                {item.files.map((file, index) => <div className="review-file" key={`${file.path}-${index}`}>
                  <div className="review-file-header">
                    <h4>{file.path}</h4>
                    <label><input type="checkbox" data-action="view-file" checked={viewed.isViewed(file.path)} onChange={event => viewed.setViewed(file.path, event.target.checked)} />{viewed.isViewed(file.path) ? "Viewed" : "Unviewed"}<span className="sr-only"> {file.path}</span></label>
                  </div>
                  <FileDiff before={file.before} after={file.after} />
                  <p className="diff-end">End of changes in {file.path}</p>
                </div>)}
                {item.commands.map((command, index) => <pre key={index}>{command}</pre>)}
                <details className="technical-details"><summary>Technical details</summary><pre>{item.payload}</pre></details>
                {!item.complete && <p role="status" className="restriction">Approval unavailable: {item.restriction}</p>}
              </article>)}
              {viewed.paths.length ? <p role="status">{viewed.viewedLabel}</p> : null}
              {!viewed.allViewed ? <p id="review-viewed-hint">View all files to approve</p> : null}
            </>}
            <div className="decision-actions">
              <button type="button" className="subtle" data-decision="reject" disabled={!canMutate || Boolean(reviewInvalid) || !review} onKeyDown={preventDecisionEnter} onClick={() => void decide(false)}>Reject</button>
              <button type="button" className="approve" data-decision="approve" aria-describedby={!viewed.allViewed ? "review-viewed-hint" : undefined}
                disabled={!canMutate || !review?.canApprove || !viewed.allViewed || Boolean(reviewInvalid)} onKeyDown={preventDecisionEnter} onClick={() => void decide(true)}>{viewed.approveLabel}</button>
            </div>
          </div> : <div className="quiet-state">{approvalRecords.length > 0 && <p>Auto-approved {approvalRecords.at(-1)?.paths.join(", ") || approvalRecords.at(-1)?.name}. Undo is in Approvals. Press m for Manual.</p>}{run ? <>
            <p>Nothing is waiting for approval.</p>
            <small>{tools.length > 0 && tools.every(tool => isReadOnlyTool(tool.name)) ? "This run is only reading files, so there is nothing to approve." : "When a step wants to change files or run a command, it shows up here first."}</small>
          </> : <>
            <p>No changes to review.</p>
            <small>When a step wants to change files or run a command, it shows up here first.</small>
          </>}</div>}
          {run?.decisions?.filter(decision => decision.finalDiff?.status === "complete").map(decision => <details key={decision.approvalId}>
            <summary>Applied change · {decision.finalDiff?.status === "complete" ? decision.finalDiff.files.length : 0} files</summary>
            {decision.finalDiff?.status === "complete" && decision.finalDiff.files.map((file, index) => <div className="review-file" key={index}><h4>{file.path}</h4><FileDiff before={file.before ?? undefined} after={file.after ?? undefined} /></div>)}
          </details>)}
          {workspace?.toolPolicy ? <p className="project-policy">Tool policy: {workspace.toolPolicy}</p> : null}
          <p className="local-note">This browser is paired with a local process on this computer. Files stay in this project.</p>
        </aside>}
      </div>
      <SessionsDrawer open={drawerOpen} grouped={grouped} projects={projects} currentKey={workspaceKey} collapsed={collapsed} sessions={sessionMap}
        loadingKey={sessionsLoading ? workspaceKey : ""} sessionId={session?.sessionId} search={search} statusFilter={statusFilter}
        statusFor={(projectKey, item) => sessionStatusLabel(item.runs.at(-1)?.status, projectKey === workspaceKey && item.sessionId === session?.sessionId && reviewInvalid.startsWith("The run changed"))}
        canSwitch={canSwitch} onSearch={setSearch} onClose={() => { setDrawerOpen(false); setStatusFilter(false); drawerButton.current?.focus(); }}
        onToggle={toggleProject} onOpenProject={key => { if (projects.find(project => project.key === key)?.unavailable) return; setWorkspaceKey(key); setDrawerOpen(false); }}
        onChoose={(key, item) => { if (key !== workspaceKey) { jump.current = { key, sessionId: item.sessionId }; setWorkspaceKey(key); } else chooseSession(item); setDrawerOpen(false); if (item.runs.at(-1)?.status === "waiting_approval") saveDiff({ ...diffLayout, minimized: false }); }}
        onAdd={() => setAddProjectOpen(true)} onForget={key => { void action(key, "forgetProject").then(() => reconnect().then(next => { contextEpoch.current += 1; setContext(next); })).catch(error => setError(errorText(error))); }}
        returnFocus={drawerButton} />
      <AddProjectDialog open={addProjectOpen} onClose={() => setAddProjectOpen(false)} />
      {approvalOpen && <ApprovalModeDialog mode={approvalMode} records={approvalRecords} saving={approvalSaving} onClose={() => setApprovalOpen(false)}
        onSave={(scope, mode) => {
          setApprovalSaving(true);
          void action<{ mode: ApprovalMode; records: ApprovalRecord[] }>(workspaceKey, "setAutoApprove", { scope, mode, sessionId: session?.sessionId ?? "" }).then(info => {
            setApprovalMode(info.mode); setApprovalRecords(info.records); setApprovalOpen(false);
          }).catch(() => setError("Could not save the approval mode.")).finally(() => setApprovalSaving(false));
        }}
        onUndo={id => {
          setApprovalSaving(true);
          void action(workspaceKey, "undoAutoApproval", { id }).then(async () => {
            const info = await action<{ mode: ApprovalMode; records: ApprovalRecord[] }>(workspaceKey, "autoApprove", { sessionId: session?.sessionId ?? "" });
            setApprovalMode(info.mode); setApprovalRecords(info.records);
            setAnnounce("Reverted the auto-approved change.");
          }).catch(() => setError("Could not undo that change. It may have been edited since.")).finally(() => setApprovalSaving(false));
        }} />}
      {limitsOpen && limitsInfo?.workspaceKey === workspaceKey && <LimitsDialog
        initial={{ task: limitsInfo.preferences.task ?? limitsInfo.preferences.project, project: limitsInfo.preferences.project }}
        onCancel={() => setLimitsOpen(false)} onSave={(scope, settings) => void saveLimits(scope, settings)}
        saving={limitsSaving} saveBlocked={Boolean(limitsError)} pricingAvailable={limitsInfo.pricing !== null} error={limitsError}
        unboundedDefault={Object.values(limitsInfo.host).every(value => value === null)}
        technicalNotice={`${limitsInfo.legacyPending ? "A previous task is still pending. Host policy is kept; restart Web after it finishes or is cancelled so the new defaults apply. " : ""}Per-operation, model, state, and loop-protection limits remain in place.${hostLimitNote(limitsInfo.host)}`} />}
      <div className="sr-only" role="status" aria-live="polite">{stateLabel}. {announce}</div>
    </div>
  );
}
