import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertOctagon,
  CheckCircle2,
  Database,
  ExternalLink,
  KeyRound,
  Lock,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Unlock,
} from 'lucide-react';
import { dqiApi } from '../services/dqiApi';
import type { BoundedRecoveryPolicy, PaperAccount } from '../types/dqi';

interface RiskAccountsWorkspaceProps {
  paperAccount: PaperAccount | null;
  onRefreshSystem: () => void;
}

const MODE_OPTIONS: Array<{
  value: BoundedRecoveryPolicy['mode'];
  label: string;
  hint: string;
}> = [
  { value: 'OFF', label: 'Off (Default)', hint: 'Never scale stake after a loss.' },
  { value: 'COOLDOWN', label: 'Cooldown Pause', hint: 'Pause trading after consecutive losses.' },
  { value: 'FIXED_STAKE_REASSESSMENT', label: 'Fixed Stake Recheck', hint: 'Keep flat stake and wait for fresh signal.' },
  { value: 'LIMITED_RECOVERY_PLAN', label: 'Limited Recovery Plan', hint: 'Strictly capped attempts and dollar loss limits.' },
];

export const RiskAccountsWorkspace: React.FC<RiskAccountsWorkspaceProps> = ({
  paperAccount,
  onRefreshSystem,
}) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Health & Migrations
  const [health, setHealth] = useState<Awaited<ReturnType<typeof dqiApi.getHealth>> | null>(null);
  const [migrating, setMigrating] = useState(false);

  // Deriv OAuth
  const [derivAuth, setDerivAuth] = useState<{ configured: boolean; connected: boolean; message: string } | null>(null);
  const [startingOAuth, setStartingOAuth] = useState(false);

  // Recovery Policy
  const [policy, setPolicy] = useState<BoundedRecoveryPolicy | null>(null);
  const [serverWorstCase, setServerWorstCase] = useState<number>(0);
  const [deploymentRecoveryFlag, setDeploymentRecoveryFlag] = useState<boolean>(false);
  const [savingPolicy, setSavingPolicy] = useState(false);

  // Live Control & Kill Switch
  const [liveControl, setLiveControl] = useState<Awaited<ReturnType<typeof dqiApi.getLiveControl>> | null>(null);
  const [killing, setKilling] = useState(false);

  // Quant Admin Session
  const [quantSession, setQuantSession] = useState<{
    configured: boolean;
    fromEnv: boolean;
    authenticated: boolean;
  } | null>(null);
  const [adminPassword, setAdminPassword] = useState('');
  const [authBusy, setAuthBusy] = useState(false);

  const loadAll = async () => {
    setLoading(true);
    setError(null);
    try {
      const [h, da, rec, lc, qs] = await Promise.all([
        dqiApi.getHealth(),
        dqiApi.getDerivAuthStatus(),
        dqiApi.getRecoveryPolicy(),
        dqiApi.getLiveControl(),
        dqiApi.getQuantSession(),
      ]);
      setHealth(h);
      setDerivAuth(da);
      setPolicy(rec.policy);
      setServerWorstCase(rec.worstCaseAdditionalLossPreview);
      setDeploymentRecoveryFlag(rec.deploymentRecoveryFlag);
      setLiveControl(lc);
      setQuantSession(qs);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load risk & account settings');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAll();
  }, []);

  const liveWorstCasePreview = useMemo(() => {
    if (!policy) return serverWorstCase;
    if (policy.mode === 'OFF') return 0;
    const capByAttempts = policy.max_attempts_session * policy.max_stake;
    return Number(Math.min(policy.max_session_loss, capByAttempts).toFixed(2));
  }, [policy, serverWorstCase]);

  const handleSavePolicy = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!policy) return;
    setSavingPolicy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await dqiApi.updateRecoveryPolicy({
        mode: policy.mode,
        real_account_opt_in: policy.real_account_opt_in,
        max_attempts_session: policy.max_attempts_session,
        cooldown_seconds: policy.cooldown_seconds,
        max_stake: policy.max_stake,
        max_balance_percent: policy.max_balance_percent,
        max_session_loss: policy.max_session_loss,
        max_daily_loss: policy.max_daily_loss,
        max_drawdown_percent: policy.max_drawdown_percent,
        max_consecutive_losses: policy.max_consecutive_losses,
        max_open_contracts: policy.max_open_contracts,
      });
      setPolicy(res.policy);
      setServerWorstCase(res.worstCaseAdditionalLossPreview);
      setNotice('Bounded recovery policy saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update policy');
    } finally {
      setSavingPolicy(false);
    }
  };

  const handleConnectDeriv = async () => {
    setStartingOAuth(true);
    setError(null);
    try {
      const res = await dqiApi.startDerivOAuth();
      window.location.assign(res.authorizationUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Deriv OAuth start failed');
      setStartingOAuth(false);
    }
  };

  const handleKillSwitch = async () => {
    setKilling(true);
    setError(null);
    setNotice(null);
    try {
      await dqiApi.activateKillSwitch();
      setNotice('Emergency Kill Switch activated. Automation and live execution halted.');
      await loadAll();
      onRefreshSystem();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kill switch failed');
    } finally {
      setKilling(false);
    }
  };

  const handleAdminSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adminPassword.trim()) return;
    setAuthBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (quantSession && !quantSession.configured) {
        await dqiApi.claimQuantAdmin(adminPassword.trim());
        setNotice('Quant Admin password claimed and session unlocked.');
      } else {
        await dqiApi.loginQuantAdmin(adminPassword.trim());
        setNotice('Quant Admin session unlocked.');
      }
      setAdminPassword('');
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setAuthBusy(false);
    }
  };

  const handleLogoutAdmin = async () => {
    setAuthBusy(true);
    setError(null);
    try {
      await dqiApi.logoutQuantAdmin();
      setNotice('Quant Admin session locked.');
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Logout failed');
    } finally {
      setAuthBusy(false);
    }
  };

  const handleApplyMigrations = async () => {
    setMigrating(true);
    setError(null);
    setNotice(null);
    try {
      const res = await dqiApi.runMigrations();
      setNotice(
        res.applied.length > 0
          ? `Applied ${res.applied.length} migration(s): ${res.applied.join(', ')}`
          : 'All migrations already applied.'
      );
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Migration failed');
    } finally {
      setMigrating(false);
    }
  };

  const pendingMigrations = useMemo(() => {
    if (!health) return [];
    const applied = new Set(health.database.appliedMigrations);
    return health.database.availableMigrations.filter((m) => !applied.has(m));
  }, [health]);

  return (
    <div className="space-y-4">
      {error && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-[#FF444F]/40 bg-[#FF444F]/10 px-4 py-2.5 text-sm text-[#FF444F]">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="text-xs font-semibold underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {notice && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-[#00A88F]/40 bg-[#00A88F]/10 px-4 py-2.5 text-sm text-[#00A88F]">
          <span>{notice}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="text-xs font-semibold underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Top Row: Emergency Kill Switch + Accounts Summary */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Emergency Kill Switch & Live Execution Gate */}
        <div className="rounded-lg border border-[#E5E9EF] bg-white p-4 dark:border-[#243040] dark:bg-[#151D27]">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-[#20242B] dark:text-[#F3F4F6]">
                Safety Gate &amp; Kill Switch
              </h2>
              <p className="mt-0.5 text-xs text-[#6B7280] dark:text-[#9CA3AF]">
                Live real-money trading is disabled by default.
              </p>
            </div>
            <ShieldAlert className="h-5 w-5 text-[#FF444F]" />
          </div>

          <div className="mt-3 space-y-2 text-xs">
            <div className="flex items-center justify-between rounded bg-[#F5F7FA] px-3 py-2 dark:bg-[#0F151D]">
              <span className="text-[#6B7280] dark:text-[#9CA3AF]">Deployment Live Gate</span>
              <span className={`font-mono font-semibold ${liveControl?.deployment_gate ? 'text-[#00A88F]' : 'text-[#20242B] dark:text-[#F3F4F6]'}`}>
                {liveControl?.deployment_gate ? 'ENABLED' : 'LOCKED (SAFE)'}
              </span>
            </div>
            <div className="flex items-center justify-between rounded bg-[#F5F7FA] px-3 py-2 dark:bg-[#0F151D]">
              <span className="text-[#6B7280] dark:text-[#9CA3AF]">Kill Switch State</span>
              <span className={`font-mono font-semibold ${liveControl?.control.kill_switch ? 'text-[#FF444F]' : 'text-[#00A88F]'}`}>
                {liveControl?.control.kill_switch ? 'TRIPPED (HALTED)' : 'READY'}
              </span>
            </div>
            <div className="flex items-center justify-between rounded bg-[#F5F7FA] px-3 py-2 dark:bg-[#0F151D]">
              <span className="text-[#6B7280] dark:text-[#9CA3AF]">Max Live Stake / Daily Loss</span>
              <span className="font-mono font-semibold tabular-nums text-[#20242B] dark:text-[#F3F4F6]">
                ${liveControl?.max_stake_cap ?? 5} / ${liveControl?.max_daily_loss_cap ?? 25}
              </span>
            </div>
          </div>

          <button
            type="button"
            disabled={killing || loading}
            onClick={handleKillSwitch}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-md bg-[#FF444F] px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-[#e53843] disabled:opacity-50"
          >
            <AlertOctagon className="h-4 w-4" />
            {killing ? 'Activating Kill Switch…' : 'Activate Emergency Kill Switch'}
          </button>
        </div>

        {/* Paper & Deriv OAuth Accounts */}
        <div className="rounded-lg border border-[#E5E9EF] bg-white p-4 dark:border-[#243040] dark:bg-[#151D27]">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-[#20242B] dark:text-[#F3F4F6]">
                Paper &amp; Deriv Accounts
              </h2>
              <p className="mt-0.5 text-xs text-[#6B7280] dark:text-[#9CA3AF]">
                Demo and Real balances remain strictly isolated.
              </p>
            </div>
            <ShieldCheck className="h-5 w-5 text-[#0866FF]" />
          </div>

          <div className="mt-3 space-y-2 text-xs">
            <div className="flex items-center justify-between rounded bg-[#F5F7FA] px-3 py-2 dark:bg-[#0F151D]">
              <span className="text-[#6B7280] dark:text-[#9CA3AF]">Local Paper Equity</span>
              <span className="font-mono font-semibold tabular-nums text-[#00A88F]">
                ${paperAccount ? paperAccount.current_equity.toFixed(2) : '10000.00'} USD
              </span>
            </div>
            <div className="flex items-center justify-between rounded bg-[#F5F7FA] px-3 py-2 dark:bg-[#0F151D]">
              <span className="text-[#6B7280] dark:text-[#9CA3AF]">Deriv OAuth App</span>
              <span className={`font-mono font-semibold ${derivAuth?.configured ? 'text-[#00A88F]' : 'text-[#6B7280]'}`}>
                {derivAuth?.configured ? 'CONFIGURED' : 'NOT SET'}
              </span>
            </div>
            <div className="flex items-center justify-between rounded bg-[#F5F7FA] px-3 py-2 dark:bg-[#0F151D]">
              <span className="text-[#6B7280] dark:text-[#9CA3AF]">Deriv Connection</span>
              <span className={`font-mono font-semibold ${derivAuth?.connected ? 'text-[#00A88F]' : 'text-[#20242B] dark:text-[#F3F4F6]'}`}>
                {derivAuth?.connected ? 'CONNECTED' : 'PAPER MODE'}
              </span>
            </div>
          </div>

          <div className="mt-3 text-xs text-[#6B7280] dark:text-[#9CA3AF]">
            {derivAuth?.message || 'Configure DERIV_CLIENT_ID and DERIV_REDIRECT_URI to connect your Deriv account via OAuth PKCE.'}
          </div>

          <button
            type="button"
            disabled={!derivAuth?.configured || startingOAuth}
            onClick={handleConnectDeriv}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-md bg-[#0866FF] px-4 py-2 text-xs font-semibold text-white transition hover:bg-[#0654d4] disabled:cursor-not-allowed disabled:opacity-45"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            {startingOAuth ? 'Redirecting to Deriv…' : derivAuth?.connected ? 'Reconnect Deriv OAuth' : 'Connect Deriv Account'}
          </button>
        </div>

        {/* Quant Admin Session & Neon DB Migrations */}
        <div className="rounded-lg border border-[#E5E9EF] bg-white p-4 dark:border-[#243040] dark:bg-[#151D27]">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-[#20242B] dark:text-[#F3F4F6]">
                Database &amp; Admin Lock
              </h2>
              <p className="mt-0.5 text-xs text-[#6B7280] dark:text-[#9CA3AF]">
                Neon PostgreSQL migrations &amp; session control.
              </p>
            </div>
            <Database className="h-5 w-5 text-[#08B9E6]" />
          </div>

          <div className="mt-3 space-y-2 text-xs">
            <div className="flex items-center justify-between rounded bg-[#F5F7FA] px-3 py-2 dark:bg-[#0F151D]">
              <span className="text-[#6B7280] dark:text-[#9CA3AF]">Storage Mode</span>
              <span className="font-mono font-semibold text-[#20242B] dark:text-[#F3F4F6]">
                {health?.database.mode === 'NEON_POSTGRES' ? 'NEON POSTGRES' : 'PREVIEW MEMORY'}
              </span>
            </div>
            <div className="flex items-center justify-between rounded bg-[#F5F7FA] px-3 py-2 dark:bg-[#0F151D]">
              <span className="text-[#6B7280] dark:text-[#9CA3AF]">Migrations Applied</span>
              <span className="font-mono font-semibold tabular-nums text-[#20242B] dark:text-[#F3F4F6]">
                {health ? `${health.database.appliedMigrations.length} / ${health.database.availableMigrations.length}` : '—'}
              </span>
            </div>
          </div>

          <button
            type="button"
            disabled={migrating || !health?.database.configured || pendingMigrations.length === 0}
            onClick={handleApplyMigrations}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-md border border-[#E5E9EF] bg-[#F5F7FA] px-3 py-2 text-xs font-semibold text-[#20242B] transition hover:bg-[#EAEFF5] disabled:cursor-not-allowed disabled:opacity-50 dark:border-[#243040] dark:bg-[#0F151D] dark:text-[#F3F4F6]"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${migrating ? 'animate-spin' : ''}`} />
            {pendingMigrations.length === 0
              ? 'All 0001–0007 Migrations Applied'
              : `Apply ${pendingMigrations.length} Pending Migration(s)`}
          </button>

          <div className="mt-3 border-t border-[#E5E9EF] pt-3 dark:border-[#243040]">
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-1.5 font-medium text-[#20242B] dark:text-[#F3F4F6]">
                {quantSession?.authenticated ? (
                  <Unlock className="h-3.5 w-3.5 text-[#00A88F]" />
                ) : (
                  <Lock className="h-3.5 w-3.5 text-[#6B7280]" />
                )}
                Quant Admin
              </span>
              <span className="font-mono text-[11px] text-[#6B7280]">
                {quantSession?.authenticated ? 'UNLOCKED' : quantSession?.configured ? 'LOCKED' : 'UNCLAIMED'}
              </span>
            </div>

            {quantSession?.authenticated ? (
              <button
                type="button"
                disabled={authBusy}
                onClick={handleLogoutAdmin}
                className="mt-2 w-full rounded-md border border-[#E5E9EF] px-3 py-1.5 text-xs font-medium text-[#20242B] hover:bg-[#F5F7FA] dark:border-[#243040] dark:text-[#F3F4F6] dark:hover:bg-[#0F151D]"
              >
                Lock Admin Session
              </button>
            ) : (
              <form onSubmit={handleAdminSubmit} className="mt-2 flex gap-2">
                <input
                  type="password"
                  value={adminPassword}
                  onChange={(e) => setAdminPassword(e.target.value)}
                  placeholder={quantSession?.configured ? 'Admin password' : 'Set admin password'}
                  className="min-w-0 flex-1 rounded-md border border-[#E5E9EF] bg-[#F5F7FA] px-2.5 py-1.5 text-xs text-[#20242B] outline-none focus:border-[#0866FF] dark:border-[#243040] dark:bg-[#0F151D] dark:text-[#F3F4F6]"
                />
                <button
                  type="submit"
                  disabled={authBusy || !adminPassword.trim()}
                  className="inline-flex items-center gap-1 rounded-md bg-[#101820] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#1f2c39] disabled:opacity-50 dark:bg-[#0866FF]"
                >
                  <KeyRound className="h-3 w-3" />
                  {quantSession?.configured ? 'Unlock' : 'Claim'}
                </button>
              </form>
            )}
          </div>
        </div>
      </div>

      {/* Bounded Loss Recovery Policy Editor */}
      <form
        onSubmit={handleSavePolicy}
        className="rounded-lg border border-[#E5E9EF] bg-white p-5 dark:border-[#243040] dark:bg-[#151D27]"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#E5E9EF] pb-3 dark:border-[#243040]">
          <div className="flex items-center gap-2.5">
            <SlidersHorizontal className="h-4 w-4 text-[#0866FF]" />
            <div>
              <h2 className="text-sm font-semibold text-[#20242B] dark:text-[#F3F4F6]">
                Bounded Loss Recovery Controller
              </h2>
              <p className="text-xs text-[#6B7280] dark:text-[#9CA3AF]">
                Strict hard caps only. Unlimited Martingale is permanently disabled.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <div className="text-right">
              <div className="text-[11px] uppercase tracking-wide text-[#6B7280] dark:text-[#9CA3AF]">
                Worst-Case Additional Loss
              </div>
              <div className="font-mono text-base font-bold tabular-nums text-[#FF4D5A]">
                ${liveWorstCasePreview.toFixed(2)}
              </div>
            </div>
            <button
              type="submit"
              disabled={savingPolicy || !policy}
              className="inline-flex items-center gap-1.5 rounded-md bg-[#0866FF] px-4 py-2 text-xs font-semibold text-white hover:bg-[#0654d4] disabled:opacity-50"
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
              {savingPolicy ? 'Saving…' : 'Save Policy'}
            </button>
          </div>
        </div>

        {policy && (
          <div className="mt-4 space-y-4">
            {/* Mode cards */}
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
              {MODE_OPTIONS.map((opt) => {
                const active = policy.mode === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setPolicy({ ...policy, mode: opt.value })}
                    className={`rounded-md border p-3 text-left transition ${
                      active
                        ? 'border-[#0866FF] bg-[#0866FF]/8'
                        : 'border-[#E5E9EF] bg-[#F5F7FA] hover:border-[#0866FF]/40 dark:border-[#243040] dark:bg-[#0F151D]'
                    }`}
                  >
                    <div className="text-xs font-semibold text-[#20242B] dark:text-[#F3F4F6]">
                      {opt.label}
                    </div>
                    <div className="mt-1 text-[11px] text-[#6B7280] dark:text-[#9CA3AF]">
                      {opt.hint}
                    </div>
                  </button>
                );
              })}
            </div>

            {!deploymentRecoveryFlag && policy.mode !== 'OFF' && (
              <div className="rounded-md border border-[#FFAD3A]/40 bg-[#FFAD3A]/10 px-3 py-2 text-xs text-[#9A5B00] dark:text-[#FFAD3A]">
                Note: Deployment flag <code className="font-mono">ENABLE_BOUNDED_RECOVERY=true</code> is required before recovery triggers on live sessions. Paper simulation settings remain saved.
              </div>
            )}

            {/* Numeric cap controls */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <label className="block text-xs">
                <span className="text-[#6B7280] dark:text-[#9CA3AF]">Max Attempts / Session</span>
                <input
                  type="number"
                  min={0}
                  max={5}
                  value={policy.max_attempts_session}
                  onChange={(e) =>
                    setPolicy({ ...policy, max_attempts_session: Math.max(0, Math.min(5, Number(e.target.value))) })
                  }
                  className="mt-1 w-full rounded-md border border-[#E5E9EF] bg-[#F5F7FA] px-2.5 py-1.5 font-mono text-xs tabular-nums text-[#20242B] dark:border-[#243040] dark:bg-[#0F151D] dark:text-[#F3F4F6]"
                />
              </label>

              <label className="block text-xs">
                <span className="text-[#6B7280] dark:text-[#9CA3AF]">Cooldown (sec)</span>
                <input
                  type="number"
                  min={5}
                  max={3600}
                  value={policy.cooldown_seconds}
                  onChange={(e) =>
                    setPolicy({ ...policy, cooldown_seconds: Math.max(5, Math.min(3600, Number(e.target.value))) })
                  }
                  className="mt-1 w-full rounded-md border border-[#E5E9EF] bg-[#F5F7FA] px-2.5 py-1.5 font-mono text-xs tabular-nums text-[#20242B] dark:border-[#243040] dark:bg-[#0F151D] dark:text-[#F3F4F6]"
                />
              </label>

              <label className="block text-xs">
                <span className="text-[#6B7280] dark:text-[#9CA3AF]">Max Stake (USD)</span>
                <input
                  type="number"
                  min={0.35}
                  step={0.5}
                  max={100}
                  value={policy.max_stake}
                  onChange={(e) =>
                    setPolicy({ ...policy, max_stake: Math.max(0.35, Math.min(100, Number(e.target.value))) })
                  }
                  className="mt-1 w-full rounded-md border border-[#E5E9EF] bg-[#F5F7FA] px-2.5 py-1.5 font-mono text-xs tabular-nums text-[#20242B] dark:border-[#243040] dark:bg-[#0F151D] dark:text-[#F3F4F6]"
                />
              </label>

              <label className="block text-xs">
                <span className="text-[#6B7280] dark:text-[#9CA3AF]">Max Session Loss ($)</span>
                <input
                  type="number"
                  min={1}
                  max={500}
                  value={policy.max_session_loss}
                  onChange={(e) =>
                    setPolicy({ ...policy, max_session_loss: Math.max(1, Math.min(500, Number(e.target.value))) })
                  }
                  className="mt-1 w-full rounded-md border border-[#E5E9EF] bg-[#F5F7FA] px-2.5 py-1.5 font-mono text-xs tabular-nums text-[#20242B] dark:border-[#243040] dark:bg-[#0F151D] dark:text-[#F3F4F6]"
                />
              </label>

              <label className="block text-xs">
                <span className="text-[#6B7280] dark:text-[#9CA3AF]">Max Daily Loss ($)</span>
                <input
                  type="number"
                  min={1}
                  max={1000}
                  value={policy.max_daily_loss}
                  onChange={(e) =>
                    setPolicy({ ...policy, max_daily_loss: Math.max(1, Math.min(1000, Number(e.target.value))) })
                  }
                  className="mt-1 w-full rounded-md border border-[#E5E9EF] bg-[#F5F7FA] px-2.5 py-1.5 font-mono text-xs tabular-nums text-[#20242B] dark:border-[#243040] dark:bg-[#0F151D] dark:text-[#F3F4F6]"
                />
              </label>

              <label className="block text-xs">
                <span className="text-[#6B7280] dark:text-[#9CA3AF]">Max Balance % / Trade</span>
                <input
                  type="number"
                  min={0.5}
                  step={0.5}
                  max={25}
                  value={policy.max_balance_percent}
                  onChange={(e) =>
                    setPolicy({ ...policy, max_balance_percent: Math.max(0.5, Math.min(25, Number(e.target.value))) })
                  }
                  className="mt-1 w-full rounded-md border border-[#E5E9EF] bg-[#F5F7FA] px-2.5 py-1.5 font-mono text-xs tabular-nums text-[#20242B] dark:border-[#243040] dark:bg-[#0F151D] dark:text-[#F3F4F6]"
                />
              </label>

              <label className="block text-xs">
                <span className="text-[#6B7280] dark:text-[#9CA3AF]">Max Drawdown %</span>
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={policy.max_drawdown_percent}
                  onChange={(e) =>
                    setPolicy({ ...policy, max_drawdown_percent: Math.max(1, Math.min(50, Number(e.target.value))) })
                  }
                  className="mt-1 w-full rounded-md border border-[#E5E9EF] bg-[#F5F7FA] px-2.5 py-1.5 font-mono text-xs tabular-nums text-[#20242B] dark:border-[#243040] dark:bg-[#0F151D] dark:text-[#F3F4F6]"
                />
              </label>

              <label className="block text-xs">
                <span className="text-[#6B7280] dark:text-[#9CA3AF]">Max Consecutive Losses</span>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={policy.max_consecutive_losses}
                  onChange={(e) =>
                    setPolicy({ ...policy, max_consecutive_losses: Math.max(1, Math.min(10, Number(e.target.value))) })
                  }
                  className="mt-1 w-full rounded-md border border-[#E5E9EF] bg-[#F5F7FA] px-2.5 py-1.5 font-mono text-xs tabular-nums text-[#20242B] dark:border-[#243040] dark:bg-[#0F151D] dark:text-[#F3F4F6]"
                />
              </label>

              <label className="block text-xs">
                <span className="text-[#6B7280] dark:text-[#9CA3AF]">Max Open Contracts</span>
                <input
                  type="number"
                  min={1}
                  max={5}
                  value={policy.max_open_contracts}
                  onChange={(e) =>
                    setPolicy({ ...policy, max_open_contracts: Math.max(1, Math.min(5, Number(e.target.value))) })
                  }
                  className="mt-1 w-full rounded-md border border-[#E5E9EF] bg-[#F5F7FA] px-2.5 py-1.5 font-mono text-xs tabular-nums text-[#20242B] dark:border-[#243040] dark:bg-[#0F151D] dark:text-[#F3F4F6]"
                />
              </label>

              <label className="flex items-center gap-2 pt-5 text-xs text-[#20242B] dark:text-[#F3F4F6]">
                <input
                  type="checkbox"
                  checked={policy.real_account_opt_in}
                  onChange={(e) => setPolicy({ ...policy, real_account_opt_in: e.target.checked })}
                  className="h-4 w-4 accent-[#0866FF]"
                />
                <span>Allow opt-in on Real account</span>
              </label>
            </div>
          </div>
        )}
      </form>
    </div>
  );
};
