import React, { useState } from 'react';
import { ExternalLink, LogOut, X } from 'lucide-react';
import { buildDerivOAuthUrl, getDerivAppId } from '../services/derivWs';
import { DerivAccount } from '../types/deriv';

interface DerivAuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  accounts: DerivAccount[];
  activeAccount: DerivAccount | null;
  onSelectAccount: (loginid: string) => void;
  onDisconnect: () => void;
}

export const DerivAuthModal: React.FC<DerivAuthModalProps> = ({
  isOpen,
  onClose,
  accounts,
  activeAccount,
  onSelectAccount,
  onDisconnect,
}) => {
  const [appId, setAppId] = useState(getDerivAppId());

  if (!isOpen) return null;

  const handleOAuthRedirect = () => {
    const cleanId = appId.trim() || '1089';
    window.localStorage.setItem('deriv_app_id', cleanId);
    window.location.href = buildDerivOAuthUrl(cleanId);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="deriv-oauth-title"
    >
      <div className="w-full max-w-md bg-white dark:bg-[#151717] border border-[#E6E9E9] dark:border-[#2A2E30] rounded p-6 space-y-5">
        <div className="flex items-center justify-between">
          <h2 id="deriv-oauth-title" className="text-base font-semibold text-[#0E0E0E] dark:text-white">
            Deriv OAuth Connection
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-[#6E757C] hover:text-[#0E0E0E] dark:hover:text-white cursor-pointer"
            aria-label="Close modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {activeAccount ? (
          <div className="space-y-4">
            <div className="p-3.5 rounded bg-[#F8F9FA] dark:bg-[#0E0E0E] border border-[#E6E9E9] dark:border-[#2A2E30] space-y-1 font-mono text-xs">
              <div className="text-[#6E757C] dark:text-[#999999] font-sans">Active Account</div>
              <div className="text-sm font-semibold text-[#0E0E0E] dark:text-white">
                {activeAccount.loginid} ({activeAccount.isVirtual ? 'Demo' : 'Real'})
              </div>
              <div className="text-[#00A79E] dark:text-[#4BB4B3] font-semibold">
                {activeAccount.balance.toFixed(2)} {activeAccount.currency}
              </div>
            </div>

            {accounts.length > 1 && (
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-[#6E757C] dark:text-[#999999]">
                  Switch OAuth Account
                </label>
                <div className="space-y-1.5">
                  {accounts.map((acc) => (
                    <button
                      key={acc.loginid}
                      type="button"
                      onClick={() => onSelectAccount(acc.loginid)}
                      className={`w-full flex items-center justify-between px-3 py-2 text-xs font-mono rounded border cursor-pointer ${
                        acc.loginid === activeAccount.loginid
                          ? 'border-[#FF444F] bg-[#FF444F]/10 text-[#0E0E0E] dark:text-white'
                          : 'border-[#E6E9E9] dark:border-[#2A2E30] text-[#333333] dark:text-[#C2C5C7]'
                      }`}
                    >
                      <span>
                        {acc.loginid} · {acc.isVirtual ? 'Demo' : 'Real'}
                      </span>
                      <span>
                        {acc.balance.toFixed(2)} {acc.currency}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <button
              type="button"
              onClick={() => {
                onDisconnect();
                onClose();
              }}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-semibold text-[#EC3F3F] border border-[#EC3F3F]/40 hover:bg-[#EC3F3F]/10 rounded cursor-pointer"
            >
              <LogOut className="w-3.5 h-3.5" />
              Disconnect Account
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-xs text-[#6E757C] dark:text-[#999999] leading-relaxed">
              Connect via official Deriv OAuth to trade live on your Demo (`VRTC`) or Real (`CR`) account. Without connecting, all 4 XML bots execute in Live-Tick Paper Mode with a $10,000 simulated balance.
            </p>

            <div>
              <label className="block text-xs font-medium text-[#333333] dark:text-[#C2C5C7] mb-1">
                Deriv App ID (set <code className="font-mono">VITE_DERIV_APP_ID</code> on Vercel)
              </label>
              <input
                type="text"
                value={appId}
                onChange={(e) => setAppId(e.target.value)}
                placeholder="e.g. 61234"
                className="w-full px-3 py-2 text-xs font-mono rounded border border-[#E6E9E9] dark:border-[#2A2E30] bg-[#F8F9FA] dark:bg-[#0E0E0E] text-[#0E0E0E] dark:text-white focus:outline-none focus:border-[#FF444F]"
              />
              <p className="text-[11px] text-[#6E757C] dark:text-[#999999] mt-1">
                Register your Vercel URL as the OAuth Redirect URL at api.deriv.com/dashboard.
              </p>
            </div>

            <button
              type="button"
              onClick={handleOAuthRedirect}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold text-white bg-[#FF444F] hover:bg-[#EB3E48] rounded transition-colors cursor-pointer"
            >
              Authorize with Deriv OAuth
              <ExternalLink className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
