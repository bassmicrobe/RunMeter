"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  Check,
  CircleAlert,
  Copy,
  ExternalLink,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  Unplug,
  WifiOff,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PROVIDER_CONSOLE_LINKS } from "@/lib/provider-console-links";
import {
  publishRelaySnapshot,
  RelayRequestError,
  RunMeterRelayClient,
  type GeminiProject,
  type ProviderConnectResult,
  type ProviderConnectPayload,
  type RelayProviderSnapshot,
} from "@/lib/relay-client";
import {
  readRelaySession,
  saveRelaySession,
} from "@/lib/relay-storage";
import type { ProviderConnection, ProviderId } from "@/lib/runmeter-types";
import { cn } from "@/lib/utils";

type RelayStep = "checking" | "offline" | "pairing" | "ready";
type GeminiConnectionStep = "login" | "choose-project";
type Operation =
  | "pair"
  | "connect"
  | "disconnect"
  | "refresh"
  | "unpair"
  | null;

const providerCopy = {
  codex: {
    title: "Codexを接続",
    summary: "Codexの公式ログイン画面で認証します。パスワードはRunMeterに入力しません。",
  },
  claude: {
    title: "Claudeを接続",
    summary: "この端末のClaude Codeから、5時間・週次の利用枠を読み取ります。",
  },
  gemini: {
    title: "Gemini APIを接続",
    summary: "Googleでログインして、利用状況を確認するCloudプロジェクトを選びます。",
  },
} satisfies Record<ProviderId, { title: string; summary: string }>;

function getErrorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "接続処理を完了できませんでした。もう一度お試しください。";
}

function getGeminiErrorMessage(
  error: unknown,
  context: "connection" | "projects" = "connection",
) {
  const code = error instanceof RelayRequestError ? error.code?.toLowerCase() : undefined;
  if (code === "oauth_client_unconfigured" || code === "google_oauth_client_unconfigured") {
    return "RunMeter RelayにGoogleログインの設定がありません。Relayを最新版に更新し、Google OAuthクライアントの設定を確認してから再起動してください。Client IDやシークレットをこの画面へ入力する必要はありません。";
  }
  if (
    code === "projects_forbidden" ||
    code === "google_projects_forbidden" ||
    (context === "projects" &&
      (code === "permission_denied" ||
        code === "insufficient_scope" ||
        (error instanceof RelayRequestError && error.status === 403)))
  ) {
    return "Google Cloudのプロジェクト一覧を表示する権限がありません。Googleアカウントにプロジェクトの閲覧権限があるか確認し、必要ならGoogleでログインし直してください。";
  }
  if (
    code === "api_disabled" ||
    code === "service_disabled" ||
    code === "cloud_resource_manager_api_disabled"
  ) {
    return "Cloud Resource Manager APIが無効です。Google Cloud ConsoleでAPIを有効にしてから、プロジェクト一覧を再読み込みしてください。";
  }
  if (code === "oauth_denied" || code === "google_oauth_denied") {
    return "Googleログインが完了していません。認証画面でアクセスを許可してから、もう一度確認してください。";
  }
  if (
    code === "google_auth_expired" ||
    code === "google_project_selection_expired" ||
    code === "google_project_selection_required" ||
    code === "invalid_grant"
  ) {
    return "Googleログインの有効期限が切れたか、認証情報を利用できません。Googleでログインし直してください。";
  }
  return getErrorMessage(error);
}

function getGeminiUnsupportedMessage(result: ProviderConnectResult) {
  if (
    result.code === "oauth_client_unconfigured" ||
    result.code === "google_oauth_client_unconfigured"
  ) {
    return "RunMeter RelayにGoogleログインの設定がありません。Relayを最新版に更新し、Google OAuthクライアントの設定を確認してから再起動してください。Client IDやシークレットをこの画面へ入力する必要はありません。";
  }
  return result.message ??
    "この環境ではGoogleログインを開始できません。Relayの設定を確認してください。";
}

function needsGeminiProjectSelection(snapshot: RelayProviderSnapshot) {
  return (
    snapshot.providerId === "gemini" &&
    snapshot.metadata?.connectionStage === "choose-project"
  );
}

function isConnectedResult(result: ProviderConnectResult) {
  return (
    result.kind === "connected" ||
    result.connected === true ||
    result.status === "connected"
  );
}

function Field({
  id,
  label,
  help,
  children,
}: {
  id: string;
  label: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-xs font-medium text-foreground">
        {label}
      </label>
      {children}
      {help ? <p className="text-[11px] leading-4 text-muted-foreground">{help}</p> : null}
    </div>
  );
}

function InlineNotice({
  tone = "normal",
  children,
}: {
  tone?: "normal" | "error" | "success";
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border px-3 py-2.5 text-xs leading-5",
        tone === "error" && "border-rose-400/35 bg-rose-400/10 text-rose-200",
        tone === "success" &&
          "border-emerald-400/30 bg-emerald-400/10 text-emerald-100",
        tone === "normal" && "border-border bg-secondary/45 text-muted-foreground",
      )}
      role={tone === "error" ? "alert" : "status"}
      aria-live="polite"
    >
      {children}
    </div>
  );
}

export function ProviderConnectionDialog({
  provider,
  open,
  onOpenChange,
}: {
  provider: ProviderConnection;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const fieldPrefix = useId();
  const [relayStep, setRelayStep] = useState<RelayStep>("checking");
  const [operation, setOperation] = useState<Operation>(null);
  const [client, setClient] = useState<RunMeterRelayClient | null>(null);
  const [pairCode, setPairCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProviderConnectResult | null>(null);
  const [localStatus, setLocalStatus] = useState<ProviderConnection["status"] | null>(null);
  const [previousProviderStatus, setPreviousProviderStatus] = useState(provider.status);
  if (previousProviderStatus !== provider.status) {
    setPreviousProviderStatus(provider.status);
    setLocalStatus(null);
  }
  const [geminiStep, setGeminiStep] = useState<GeminiConnectionStep>("login");
  const [geminiProjects, setGeminiProjects] = useState<GeminiProject[]>([]);
  const [geminiProjectsTruncated, setGeminiProjectsTruncated] = useState(false);
  const [geminiProjectsLoading, setGeminiProjectsLoading] = useState(false);
  const [geminiProjectsError, setGeminiProjectsError] = useState<string | null>(null);
  const [selectedGeminiProjectId, setSelectedGeminiProjectId] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const copiedTimer = useRef<number | null>(null);
  const geminiProjectsRequestId = useRef(0);
  const geminiProjectsRequestPending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (copiedTimer.current) window.clearTimeout(copiedTimer.current);
    };
  }, []);

  const copyText = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      if (!mounted.current) return;
      setCopied(label);
      setError(null);
      if (copiedTimer.current) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(null), 2_000);
    } catch {
      if (mounted.current) {
        setError("コピーできませんでした。表示された文字を選択してコピーしてください。");
      }
    }
  };

  const details = providerCopy[provider.id];
  const liveStatus = localStatus ?? provider.status;
  const consoleLink = PROVIDER_CONSOLE_LINKS[provider.id];
  const isConnected = liveStatus === "connected" || isConnectedResult(result ?? {});
  const geminiConnectionPending =
    provider.id === "gemini" &&
    (geminiStep === "choose-project" ||
      Boolean(result?.authUrl || result?.deviceCode || result?.userCode));
  const canDisconnect =
    (isConnected || liveStatus === "degraded") && !geminiConnectionPending;
  const isBusy =
    operation !== null || relayStep === "checking" || geminiProjectsLoading;
  const activeGeminiProjects = geminiProjects.filter(
    (project) => project.state === "ACTIVE",
  );

  const loadGeminiProjects = useCallback(
    async (
      activeClient: RunMeterRelayClient,
      isCancelled: () => boolean = () => false,
    ) => {
      if (geminiProjectsRequestPending.current) return;
      geminiProjectsRequestPending.current = true;
      const requestId = ++geminiProjectsRequestId.current;
      if (!isCancelled()) {
        setGeminiProjectsLoading(true);
        setGeminiProjectsError(null);
        setSelectedGeminiProjectId("");
      }
      try {
        const response = await activeClient.geminiProjects();
        if (isCancelled() || requestId !== geminiProjectsRequestId.current) return;
        setGeminiProjects(response.projects);
        setGeminiProjectsTruncated(response.truncated);
      } catch (requestError) {
        if (isCancelled() || requestId !== geminiProjectsRequestId.current) return;
        if (requestError instanceof RelayRequestError && requestError.status === 401) {
          if (!(await activeClient.forgetSession())) return;
          if (isCancelled() || requestId !== geminiProjectsRequestId.current) return;
          setClient(null);
          setResult(null);
          setRelayStep("pairing");
          setError(
            "Relayとのペアリング期限が切れました。もう一度ペアリングしてください。",
          );
          return;
        }
        setGeminiProjects([]);
        setGeminiProjectsTruncated(false);
        setGeminiProjectsError(getGeminiErrorMessage(requestError, "projects"));
      } finally {
        if (requestId === geminiProjectsRequestId.current) {
          geminiProjectsRequestPending.current = false;
          if (!isCancelled()) setGeminiProjectsLoading(false);
        }
      }
    },
    [],
  );

  const enterGeminiProjectSelection = useCallback(
    async (
      snapshot: RelayProviderSnapshot,
      activeClient: RunMeterRelayClient,
      isCancelled: () => boolean = () => false,
    ) => {
      if (!needsGeminiProjectSelection(snapshot) || isCancelled()) return false;
      setGeminiStep("choose-project");
      if (geminiProjectsRequestPending.current) return true;
      await loadGeminiProjects(activeClient, isCancelled);
      if (!isCancelled()) setResult(null);
      return true;
    },
    [loadGeminiProjects],
  );

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    void Promise.all([new RunMeterRelayClient().health(), readRelaySession()])
      .then(async ([, session]) => {
        if (cancelled) return;
        if (!session) {
          setRelayStep("pairing");
          return;
        }

        const nextClient = new RunMeterRelayClient(session);
        try {
          const providerSnapshot = await nextClient.providerSnapshot(provider.id);
          if (cancelled) return;
          setLocalStatus(
            providerSnapshot.status === "connected"
              ? "connected"
              : providerSnapshot.status === "error" ||
                  providerSnapshot.status === "degraded"
                ? "degraded"
                : "disconnected",
          );
          setError(providerSnapshot.error?.message ?? null);
          setClient(nextClient);
          setRelayStep("ready");
          if (needsGeminiProjectSelection(providerSnapshot)) {
            void enterGeminiProjectSelection(
              providerSnapshot,
              nextClient,
              () => cancelled,
            );
          }
        } catch (requestError) {
          if (cancelled) return;
          if (requestError instanceof RelayRequestError && requestError.status === 401) {
            if (!(await nextClient.forgetSession())) return;
            if (!cancelled) setRelayStep("pairing");
            return;
          }
          throw requestError;
        }
      })
      .catch((requestError: unknown) => {
        if (cancelled) return;
        const relayIsOffline =
          requestError instanceof RelayRequestError && requestError.status === null;
        setError(relayIsOffline ? null : getErrorMessage(requestError));
        setRelayStep(relayIsOffline ? "offline" : "pairing");
      });

    return () => {
      cancelled = true;
    };
  }, [enterGeminiProjectSelection, open, provider.id]);

  useEffect(() => {
    const awaitingAuth =
      open &&
      relayStep === "ready" &&
      client &&
      !isConnected &&
      Boolean(result?.kind === "action-required" || result?.authUrl || result?.deviceCode || result?.userCode);
    if (!awaitingAuth) return;

    let cancelled = false;
    let checking = false;
    const checkStatus = async () => {
      if (checking || document.hidden) return;
      checking = true;
      try {
        const snapshot = await client.providerSnapshot(provider.id);
        if (
          !cancelled &&
          (await enterGeminiProjectSelection(snapshot, client, () => cancelled))
        ) {
          return;
        }
        if (!cancelled && snapshot.status === "error") {
          setLocalStatus("degraded");
          setResult(null);
          setError(
            snapshot.error
              ? provider.id === "gemini"
                ? getGeminiErrorMessage(
                    new RelayRequestError(
                      snapshot.error.message,
                      null,
                      snapshot.error.code,
                    ),
                  )
                : snapshot.error.message
              : "認証を完了できませんでした。もう一度お試しください。",
          );
          return;
        }
        if (!cancelled && snapshot.status === "connected") {
          setLocalStatus("connected");
          setResult({ kind: "connected", connected: true, message: "接続できました" });
          window.dispatchEvent(new Event("runmeter:relay-refresh"));
        }
      } catch (requestError) {
        if (cancelled) return;
        if (requestError instanceof RelayRequestError && requestError.status === 401) {
          if (!(await client.forgetSession())) return;
          if (!cancelled) {
            setClient(null);
            setResult(null);
            setRelayStep("pairing");
            setError("Relayとのペアリング期限が切れました。もう一度ペアリングしてください。");
          }
        } else if (
          !cancelled &&
          requestError instanceof RelayRequestError &&
          requestError.status !== null
        ) {
          setResult(null);
          setError(
            provider.id === "gemini"
              ? getGeminiErrorMessage(requestError)
              : getErrorMessage(requestError),
          );
        }
        // OAuth画面の操作中の一時的な取得失敗は、手動確認で再試行できます。
      } finally {
        checking = false;
      }
    };
    const intervalId = window.setInterval(checkStatus, 2_500);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [
    client,
    enterGeminiProjectSelection,
    isConnected,
    open,
    provider.id,
    relayStep,
    result,
  ]);

  const handleRequestError = async (requestError: unknown) => {
    if (!mounted.current) return;
    if (requestError instanceof RelayRequestError && requestError.status === 401) {
      if (client && !(await client.forgetSession())) return;
      setClient(null);
      setResult(null);
      setRelayStep("pairing");
    }
    setError(
      provider.id === "gemini"
        ? getGeminiErrorMessage(requestError)
        : getErrorMessage(requestError),
    );
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      setRelayStep("checking");
      setError(null);
    }
    onOpenChange(nextOpen);
    if (!nextOpen) {
      geminiProjectsRequestId.current += 1;
      geminiProjectsRequestPending.current = false;
      setPairCode("");
      setError(null);
      setResult(null);
      setGeminiStep("login");
      setGeminiProjects([]);
      setGeminiProjectsTruncated(false);
      setGeminiProjectsLoading(false);
      setGeminiProjectsError(null);
      setSelectedGeminiProjectId("");
      setCopied(null);
    }
  };

  const retryRelay = () => {
    onOpenChange(false);
    window.setTimeout(() => onOpenChange(true), 0);
  };

  const handlePair = async () => {
    const normalizedCode = pairCode.trim();
    if (!/^\d{6}$/.test(normalizedCode)) {
      setError("RunMeterに表示された6桁の数字を入力してください");
      return;
    }

    setOperation("pair");
    setError(null);
    try {
      const pairResponse = await new RunMeterRelayClient().pair(normalizedCode);
      const session = await saveRelaySession(pairResponse.token, {
        tokenVersion: pairResponse.tokenVersion,
        expiresAt: pairResponse.expiresAt,
      });
      const nextClient = new RunMeterRelayClient(session);
      setClient(nextClient);
      setRelayStep("ready");
      setPairCode("");
      window.dispatchEvent(new Event("runmeter:relay-refresh"));
      const providerSnapshot = await nextClient.providerSnapshot(provider.id);
      setLocalStatus(
        providerSnapshot.status === "connected" ? "connected"
          : providerSnapshot.status === "error" || providerSnapshot.status === "degraded"
            ? "degraded" : "disconnected",
      );
      if (needsGeminiProjectSelection(providerSnapshot)) {
        void enterGeminiProjectSelection(providerSnapshot, nextClient);
      }
    } catch (requestError) {
      await handleRequestError(requestError);
    } finally {
      setOperation(null);
    }
  };

  const refreshDashboard = async (activeClient: RunMeterRelayClient) => {
    try {
      const snapshot = await activeClient.snapshot();
      if (await activeClient.isCurrentSession() && mounted.current) {
        publishRelaySnapshot(snapshot);
      }
    } catch (requestError) {
      if (!mounted.current) return;
      if (requestError instanceof RelayRequestError && requestError.status === 401) {
        if (!(await activeClient.forgetSession())) return;
        setClient(null);
        setResult(null);
        setRelayStep("pairing");
        setError("Relayとのペアリング期限が切れました。もう一度ペアリングしてください。");
      }
      // Provider単体の接続は完了済みです。全体snapshotは次回の定期更新に任せます。
    }
  };

  const connect = async (payload: ProviderConnectPayload) => {
    if (!client) return;
    setOperation("connect");
    setError(null);
    setGeminiProjectsError(null);
    setResult(null);
    if (provider.id === "gemini" && payload.mode === "oauth") {
      geminiProjectsRequestId.current += 1;
      setGeminiStep("login");
      setGeminiProjects([]);
      setGeminiProjectsTruncated(false);
      setSelectedGeminiProjectId("");
    }
    try {
      const connectResult = await client.connectProvider(provider.id, payload);
      setResult(connectResult);
      if (isConnectedResult(connectResult)) {
        setLocalStatus("connected");
        setGeminiStep("login");
        setGeminiProjects([]);
        setGeminiProjectsTruncated(false);
        setSelectedGeminiProjectId("");
        await refreshDashboard(client);
      } else {
        window.dispatchEvent(new Event("runmeter:relay-refresh"));
      }
    } catch (requestError) {
      await handleRequestError(requestError);
    } finally {
      setOperation(null);
    }
  };

  const disconnect = async () => {
    if (!client) return;
    setOperation("disconnect");
    setError(null);
    try {
      await client.disconnectProvider(provider.id);
      setLocalStatus("disconnected");
      setResult(null);
      setGeminiStep("login");
      setGeminiProjects([]);
      setGeminiProjectsTruncated(false);
      setGeminiProjectsError(null);
      setSelectedGeminiProjectId("");
      await refreshDashboard(client);
    } catch (requestError) {
      await handleRequestError(requestError);
    } finally {
      setOperation(null);
    }
  };

  const refreshConnection = async () => {
    if (!client) return;
    setOperation("refresh");
    setError(null);
    try {
      const beforeRefresh = await client.providerSnapshot(provider.id);
      if (await enterGeminiProjectSelection(beforeRefresh, client)) return;
      if (provider.id === "gemini" && beforeRefresh.status === "connecting") {
        // Googleの認可画面を待っている間は状態確認だけに留めます。
        // refreshを呼ぶと、未確定のprojectIdを接続解除と誤判定し得ます。
        setError(null);
        return;
      }
      const refreshResult = await client.refreshProvider(provider.id);
      const providerSnapshot = await client.providerSnapshot(provider.id);
      if (await enterGeminiProjectSelection(providerSnapshot, client)) return;
      if (providerSnapshot.status === "connected" || isConnectedResult(refreshResult)) {
        setLocalStatus("connected");
        setResult({ ...refreshResult, kind: "connected", connected: true });
        await refreshDashboard(client);
      } else {
        setLocalStatus(
          providerSnapshot.status === "error" ||
            providerSnapshot.status === "degraded"
            ? "degraded"
            : "disconnected",
        );
        setError(providerSnapshot.error?.message ?? null);
        setResult(refreshResult);
      }
    } catch (requestError) {
      await handleRequestError(requestError);
    } finally {
      setOperation(null);
    }
  };

  const unpairRelay = async () => {
    setOperation("unpair");
    setError(null);
    let revokeWarning: string | null = null;
    try {
      if (client) await client.unpair();
    } catch (requestError) {
      if (!(requestError instanceof RelayRequestError && requestError.status === 401)) {
        revokeWarning =
          "ブラウザ内の連携情報は削除しましたが、Relay側のセッションを失効できませんでした。Relay再起動後にセッション管理を確認してください。";
      }
    }

    try {
      if (client) await client.forgetSession();
    } catch {
      setError("ブラウザ内の連携情報を削除できませんでした。ブラウザのストレージ設定を確認して、もう一度お試しください。");
      setOperation(null);
      return;
    }
    setClient(null);
    setResult(null);
    setLocalStatus("disconnected");
    setGeminiStep("login");
    setGeminiProjects([]);
    setGeminiProjectsTruncated(false);
    setGeminiProjectsLoading(false);
    setGeminiProjectsError(null);
    setSelectedGeminiProjectId("");
    setRelayStep("pairing");
    setError(revokeWarning);
    setOperation(null);
    window.dispatchEvent(new Event("runmeter:relay-refresh"));
  };

  const actionCode = result?.userCode ?? result?.deviceCode;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
        <DialogHeader className="pe-8">
          <DialogTitle>{details.title}</DialogTitle>
          <DialogDescription className="leading-5">{details.summary}</DialogDescription>
        </DialogHeader>

        {relayStep === "checking" ? (
          <div
            className="flex min-h-36 flex-col items-center justify-center gap-3 text-center text-xs text-muted-foreground"
            role="status"
            aria-live="polite"
          >
            <LoaderCircle className="size-5 animate-spin" aria-hidden="true" />
            この端末のRelayを確認しています
          </div>
        ) : null}

        {relayStep === "offline" ? (
          <div className="space-y-3">
            <InlineNotice tone="error">
              <span className="flex items-start gap-2">
                <WifiOff className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>
                  このPCでRunMeterが起動していません。RunMeterアプリを起動してから再確認してください。
                </span>
              </span>
            </InlineNotice>
            <ol className="list-decimal space-y-1.5 ps-5 text-xs leading-5 text-muted-foreground">
              <li>Windowsはスタートメニュー、Macは「アプリケーション」フォルダーから「RunMeter」を起動します。</li>
              <li>RunMeterに表示されるペアリングコードを確認します。</li>
              <li>この画面へ戻り、「再確認」を押します。</li>
            </ol>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button onClick={retryRelay} className="w-full sm:flex-1">
                <RefreshCw className="size-4" aria-hidden="true" />
                再確認
              </Button>
              <Button variant="outline" asChild className="w-full sm:flex-1">
                <a
                  href="/guide"
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  使い方マニュアル
                  <ExternalLink className="size-3.5" aria-hidden="true" />
                </a>
              </Button>
            </div>
            <details className="rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
              <summary className="min-h-11 cursor-pointer py-3 font-medium text-foreground sm:min-h-0 sm:py-1">
                開発者向け：Relayを手動で起動する
              </summary>
              <div className="mt-2 flex items-center justify-between gap-2 rounded-md bg-secondary/45 px-3 py-2">
                <code className="min-w-0 overflow-x-auto font-mono text-[11px]">
                  npm --prefix relay start
                </code>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="size-11 shrink-0 sm:size-9"
                  onClick={() => void copyText("npm --prefix relay start", "Relay起動コマンド")}
                  aria-label="Relay起動コマンドをコピー"
                >
                  {copied === "Relay起動コマンド" ? (
                    <Check className="size-3.5" aria-hidden="true" />
                  ) : (
                    <Copy className="size-3.5" aria-hidden="true" />
                  )}
                </Button>
              </div>
              <p className="mt-1 text-[11px]" role="status" aria-live="polite">
                {copied ? "コピーしました" : "開発環境でだけ使用してください"}
              </p>
            </details>
          </div>
        ) : null}

        {relayStep === "pairing" ? (
          <div className="space-y-3">
            <InlineNotice>
              Relayに表示されたコードで、このブラウザを端末とペアリングします。保存するのはRelay用トークンだけです。
            </InlineNotice>
            <Field id={`${fieldPrefix}-pair-code`} label="ペアリングコード">
              <Input
                id={`${fieldPrefix}-pair-code`}
                value={pairCode}
                onChange={(event) =>
                  setPairCode(
                    event.target.value.replace(/[^0-9]/g, "").slice(0, 6),
                  )
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter" && operation !== "pair") void handlePair();
                }}
                inputMode="numeric"
                maxLength={6}
                autoComplete="one-time-code"
                placeholder="例: 482193"
                className="h-11 text-center font-mono text-lg tracking-[0.25em]"
                autoFocus
              />
            </Field>
            <Button
              onClick={() => void handlePair()}
              disabled={operation === "pair" || !/^\d{6}$/.test(pairCode)}
              className="w-full"
            >
              {operation === "pair" ? (
                <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <LockKeyhole className="size-4" aria-hidden="true" />
              )}
              この端末とペアリング
            </Button>
          </div>
        ) : null}

        {relayStep === "ready" ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between rounded-lg border border-border bg-secondary/40 px-3 py-2 text-xs">
              <span className="inline-flex items-center gap-2 text-muted-foreground">
                <span className="size-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
                Relay接続済み
              </span>
              <span className={isConnected ? "text-emerald-300" : "text-muted-foreground"}>
                {isConnected ? `${provider.name}接続済み` : `${provider.name}未接続`}
              </span>
            </div>

            {!isConnected && provider.id === "codex" ? (
              <div className="space-y-3">
                <p className="text-xs leading-5 text-muted-foreground">
                  接続を開始すると公式ログインURLが表示されます。ログイン後、使用率とリセット日時をRelayが取得します。
                </p>
                <Button
                  className="w-full"
                  disabled={isBusy}
                  onClick={() => void connect({ mode: "chatgpt" })}
                >
                  {operation === "connect" ? (
                    <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <ExternalLink className="size-4" aria-hidden="true" />
                  )}
                  Codexへログイン
                </Button>
              </div>
            ) : null}

            {!isConnected && provider.id === "claude" ? (
              <div className="space-y-3">
                <InlineNotice>
                  Claude CodeをこのPCにインストールしてログインし、1回以上メッセージを送信してください。Relayが公式statusLine連携を自動設定します。
                </InlineNotice>
                <div className="rounded-lg border border-border bg-background px-3 py-2 font-mono text-[11px] text-foreground/80">
                  claude
                </div>
                <Button
                  className="w-full"
                  disabled={isBusy}
                  onClick={() => void connect({ mode: "statusline" })}
                >
                  {operation === "connect" ? (
                    <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <RefreshCw className="size-4" aria-hidden="true" />
                  )}
                  Claude Codeを検出
                </Button>
              </div>
            ) : null}

            {!isConnected && provider.id === "gemini" && geminiStep === "login" ? (
              <div className="space-y-3">
                <p className="text-xs leading-5 text-muted-foreground">
                  Googleの公式画面でログインします。Client IDやシークレットの入力は不要で、このブラウザにも保存しません。
                </p>
                <Button
                  className="w-full"
                  disabled={isBusy}
                  onClick={() => void connect({ mode: "oauth" })}
                >
                  {operation === "connect" ? (
                    <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <ExternalLink className="size-4" aria-hidden="true" />
                  )}
                  Googleでログイン
                </Button>
              </div>
            ) : null}

            {!isConnected &&
            provider.id === "gemini" &&
            geminiStep === "choose-project" ? (
              <div className="space-y-3">
                <div>
                  <div className="text-sm font-medium text-foreground">
                    利用状況を確認するプロジェクト
                  </div>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    Googleアカウントから取得した一覧です。1件だけでも自動では選びません。
                  </p>
                </div>

                {geminiProjectsLoading ? (
                  <div className="flex min-h-24 items-center justify-center gap-2 text-xs text-muted-foreground">
                    <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                    プロジェクトを読み込んでいます
                  </div>
                ) : null}

                {!geminiProjectsLoading && geminiProjectsError ? (
                  <div className="space-y-2">
                    <InlineNotice tone="error">{geminiProjectsError}</InlineNotice>
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full"
                      onClick={() => client && void loadGeminiProjects(client)}
                    >
                      <RefreshCw className="size-4" aria-hidden="true" />
                      プロジェクト一覧を再読み込み
                    </Button>
                    <Button
                      type="button"
                      className="w-full"
                      onClick={() => void connect({ mode: "oauth" })}
                    >
                      <ExternalLink className="size-4" aria-hidden="true" />
                      Googleでログインし直す
                    </Button>
                  </div>
                ) : null}

                {!geminiProjectsLoading &&
                !geminiProjectsError &&
                activeGeminiProjects.length === 0 ? (
                  <div className="space-y-2">
                    <InlineNotice tone="error">
                      選択できる有効なGoogle Cloudプロジェクトが見つかりません。Googleアカウントにプロジェクトの閲覧権限があるか、Cloud Resource Manager APIが有効かを確認してください。
                    </InlineNotice>
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full"
                      onClick={() => client && void loadGeminiProjects(client)}
                    >
                      <RefreshCw className="size-4" aria-hidden="true" />
                      プロジェクト一覧を再読み込み
                    </Button>
                  </div>
                ) : null}

                {!geminiProjectsLoading &&
                !geminiProjectsError &&
                activeGeminiProjects.length > 0 ? (
                  <>
                    <Field
                      id={`${fieldPrefix}-gemini-project`}
                      label="Google Cloudプロジェクト"
                    >
                      <Select
                        value={selectedGeminiProjectId}
                        onValueChange={setSelectedGeminiProjectId}
                      >
                        <SelectTrigger
                          id={`${fieldPrefix}-gemini-project`}
                          className="h-11 w-full min-w-0"
                        >
                          <SelectValue placeholder="プロジェクトを選択" />
                        </SelectTrigger>
                        <SelectContent
                          position="popper"
                          align="start"
                          className="max-w-[calc(100vw-3rem)]"
                        >
                          {geminiProjects.map((project) => (
                            <SelectItem
                              key={project.id}
                              value={project.id}
                              disabled={project.state !== "ACTIVE"}
                            >
                              {project.displayName}（{project.id}）
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                    <Button
                      className="w-full"
                      disabled={isBusy || !selectedGeminiProjectId}
                      onClick={() =>
                        void connect({
                          mode: "select-project",
                          options: { projectId: selectedGeminiProjectId },
                        })
                      }
                    >
                      {operation === "connect" ? (
                        <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                      ) : (
                        <Check className="size-4" aria-hidden="true" />
                      )}
                      このプロジェクトを使う
                    </Button>
                  </>
                ) : null}

                {geminiProjectsTruncated ? (
                  <InlineNotice>
                    プロジェクト数が多いため一覧は一部だけ表示しています。見つからない場合はGoogle Cloud Consoleでプロジェクトと権限を確認してください。
                  </InlineNotice>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full text-xs text-muted-foreground"
                  disabled={operation !== null}
                  onClick={() => void disconnect()}
                >
                  <Unplug className="size-4" aria-hidden="true" />
                  プロジェクト選択を中止して認証情報を削除
                </Button>
              </div>
            ) : null}

            {result?.kind === "unsupported" ? (
              <InlineNotice tone={provider.id === "gemini" ? "error" : "normal"}>
                {provider.id === "gemini"
                  ? getGeminiUnsupportedMessage(result)
                  : result.message ??
                    "この環境では自動接続を利用できません。公式画面をご確認ください。"}
              </InlineNotice>
            ) : null}

            {result?.authUrl || actionCode || result?.instructions || result?.command ? (
              <div className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-3">
                <div className="text-xs font-medium text-foreground">認証を完了してください</div>
                {result?.instructions?.length ? (
                  <ol className="list-decimal space-y-1 ps-5 text-xs leading-5 text-muted-foreground">
                    {result.instructions.map((instruction) => (
                      <li key={instruction}>{instruction}</li>
                    ))}
                  </ol>
                ) : null}
                {result?.command ? (
                  <div className="flex items-center justify-between rounded-md border border-border bg-background px-3 py-2">
                    <code className="min-w-0 truncate font-mono text-[11px]">
                      {result.command}
                    </code>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="size-11 shrink-0 sm:size-9"
                      onClick={() => void copyText(result.command ?? "", "コマンド")}
                      aria-label="コマンドをコピー"
                    >
                      {copied === "コマンド" ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
                    </Button>
                  </div>
                ) : null}
                {actionCode ? (
                  <div className="flex items-center justify-between rounded-md border border-border bg-background px-3 py-2">
                    <code className="font-mono text-base font-semibold tracking-[0.16em]">
                      {actionCode}
                    </code>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="size-11 shrink-0 sm:size-9"
                      onClick={() => void copyText(actionCode, "認証コード")}
                      aria-label="認証コードをコピー"
                    >
                      {copied === "認証コード" ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
                    </Button>
                  </div>
                ) : null}
                {result?.authUrl ? (
                  <Button asChild className="w-full">
                    <a href={result.authUrl} target="_blank" rel="noreferrer noopener">
                      認証画面を開く
                      <ExternalLink className="size-4" aria-hidden="true" />
                    </a>
                  </Button>
                ) : null}
                <Button
                  variant="outline"
                  className="w-full"
                  disabled={operation === "refresh"}
                  onClick={() => void refreshConnection()}
                >
                  {operation === "refresh" ? (
                    <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <RefreshCw className="size-4" aria-hidden="true" />
                  )}
                  認証完了を確認
                </Button>
                {provider.id === "gemini" ? (
                  <Button
                    type="button"
                    variant="ghost"
                    className="w-full text-xs text-muted-foreground"
                    disabled={operation !== null}
                    onClick={() => void disconnect()}
                  >
                    <Unplug className="size-4" aria-hidden="true" />
                    Google認証を中止
                  </Button>
                ) : null}
              </div>
            ) : null}

            {isConnected ? (
              <InlineNotice tone="success">
                <span className="flex items-center gap-2">
                  <Check className="size-4 shrink-0" aria-hidden="true" />
                  {result?.message ?? `${provider.name}から利用状況を取得できます。`}
                </span>
              </InlineNotice>
            ) : null}

            {canDisconnect ? (
              <Button
                variant="outline"
                className="w-full text-muted-foreground"
                disabled={isBusy}
                onClick={() => void disconnect()}
              >
                {operation === "disconnect" ? (
                  <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Unplug className="size-4" aria-hidden="true" />
                )}
                接続を解除
              </Button>
            ) : null}

            <Button
              variant="ghost"
              className="w-full text-xs text-muted-foreground"
              disabled={isBusy}
              onClick={() => void unpairRelay()}
            >
              {operation === "unpair" ? (
                <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Unplug className="size-4" aria-hidden="true" />
              )}
              Relayとの連携を解除
            </Button>
          </div>
        ) : null}

        {copied ? <p role="status" className="text-xs text-muted-foreground">{copied}をコピーしました</p> : null}

        {error ? (
          <InlineNotice tone="error">
            <span className="flex items-start gap-2">
              <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>{error}</span>
            </span>
          </InlineNotice>
        ) : null}

        <div className="border-t border-border pt-3">
          <Button variant="ghost" asChild className="w-full justify-between px-2 text-xs">
            <a
              href={consoleLink.url}
              target="_blank"
              rel="noreferrer noopener"
              title={consoleLink.scope}
            >
              {consoleLink.label}で確認
              <ExternalLink className="size-3.5" aria-hidden="true" />
            </a>
          </Button>
          <p className="px-2 pt-1 text-[11px] leading-4 text-muted-foreground">
            認証情報はこのPCのRunMeterから各サービスの公式認証先にだけ送られ、RunMeterのWebサーバーには送信・保存されません。
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
