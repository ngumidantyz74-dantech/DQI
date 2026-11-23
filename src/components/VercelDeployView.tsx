import React, { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { getDerivAppId } from '../services/derivWs';

export const VercelDeployView: React.FC = () => {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const currentOrigin = typeof window !== 'undefined' ? window.location.origin : 'https://your-app.vercel.app';
  const currentAppId = getDerivAppId();

  const copyText = async (key: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1600);
  };

  return (
    <div className="max-w-4xl space-y-5">
      <div>
        <h1 className="text-lg font-semibold text-[#0E0E0E] dark:text-white">
          GitHub & Vercel Deployment Configuration
        </h1>
        <p className="text-xs text-[#6E757C] dark:text-[#999999] mt-0.5">
          Everything in this project is configured as a zero-backend static Vite SPA for instant Vercel hosting
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="p-4 rounded bg-white dark:bg-[#151717] border border-[#E6E9E9] dark:border-[#2A2E30] space-y-2">
          <div className="text-xs font-semibold text-[#0E0E0E] dark:text-white">
            01. Push to GitHub & Import in Vercel
          </div>
          <p className="text-xs text-[#6E757C] dark:text-[#999999] leading-relaxed">
            Vercel automatically detects Vite. `vercel.json` is already included with SPA rewrites so Deriv OAuth redirects resolve cleanly without 404 errors.
          </p>
          <div className="pt-2 font-mono text-[11px] space-y-1 text-[#333333] dark:text-[#C2C5C7]">
            <div>Build Command: <span className="text-[#0E0E0E] dark:text-white">npm run build</span></div>
            <div>Output Directory: <span className="text-[#0E0E0E] dark:text-white">dist</span></div>
          </div>
        </div>

        <div className="p-4 rounded bg-white dark:bg-[#151717] border border-[#E6E9E9] dark:border-[#2A2E30] space-y-2">
          <div className="text-xs font-semibold text-[#0E0E0E] dark:text-white">
            02. Register Deriv OAuth App ID
          </div>
          <p className="text-xs text-[#6E757C] dark:text-[#999999] leading-relaxed">
            Register an application at <span className="font-mono text-[#0E0E0E] dark:text-white">api.deriv.com/dashboard</span> with scopes <span className="font-mono">read</span> & <span className="font-mono">trade</span>, and set your Vercel production domain as the Redirect URL.
          </p>
          <div className="pt-2 font-mono text-[11px] text-[#333333] dark:text-[#C2C5C7]">
            Active App ID: <span className="text-[#FF444F] font-semibold">{currentAppId}</span>
          </div>
        </div>
      </div>

      <div className="bg-white dark:bg-[#151717] border border-[#E6E9E9] dark:border-[#2A2E30] rounded p-5 space-y-4">
        <h2 className="text-sm font-semibold text-[#0E0E0E] dark:text-white">
          Environment Variables & Redirect URI
        </h2>

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-4 p-3 rounded bg-[#F8F9FA] dark:bg-[#0E0E0E] border border-[#E6E9E9] dark:border-[#2A2E30]">
            <div className="min-w-0">
              <div className="text-[11px] text-[#6E757C] dark:text-[#999999]">
                Vercel Environment Variable
              </div>
              <div className="text-xs font-mono text-[#0E0E0E] dark:text-white truncate mt-0.5">
                VITE_DERIV_APP_ID=YOUR_APP_ID
              </div>
            </div>
            <button
              type="button"
              onClick={() => copyText('env', 'VITE_DERIV_APP_ID=')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded border border-[#E6E9E9] dark:border-[#2A2E30] text-[#333333] dark:text-[#C2C5C7] hover:text-[#0E0E0E] dark:hover:text-white shrink-0 cursor-pointer"
            >
              {copiedKey === 'env' ? <Check className="w-3.5 h-3.5 text-[#4BB4B3]" /> : <Copy className="w-3.5 h-3.5" />}
              {copiedKey === 'env' ? 'Copied' : 'Copy'}
            </button>
          </div>

          <div className="flex items-center justify-between gap-4 p-3 rounded bg-[#F8F9FA] dark:bg-[#0E0E0E] border border-[#E6E9E9] dark:border-[#2A2E30]">
            <div className="min-w-0">
              <div className="text-[11px] text-[#6E757C] dark:text-[#999999]">
                Current Origin OAuth Redirect URI
              </div>
              <div className="text-xs font-mono text-[#0E0E0E] dark:text-white truncate mt-0.5">
                {currentOrigin}/
              </div>
            </div>
            <button
              type="button"
              onClick={() => copyText('uri', `${currentOrigin}/`)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded border border-[#E6E9E9] dark:border-[#2A2E30] text-[#333333] dark:text-[#C2C5C7] hover:text-[#0E0E0E] dark:hover:text-white shrink-0 cursor-pointer"
            >
              {copiedKey === 'uri' ? <Check className="w-3.5 h-3.5 text-[#4BB4B3]" /> : <Copy className="w-3.5 h-3.5" />}
              {copiedKey === 'uri' ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
