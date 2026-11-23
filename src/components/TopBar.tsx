import React from 'react';

export type AppView = 'runner' | 'library' | 'analytics' | 'deploy';

interface TopBarProps {
  activeView: AppView;
  onNavigate: (view: AppView) => void;
  accountLoginId: string | null;
  onOpenConnect: () => void;
}

const NAV_ITEMS: { id: AppView; label: string }[] = [
  { id: 'runner', label: 'Bot Runner' },
  { id: 'library', label: 'XML Library' },
  { id: 'analytics', label: 'CSV Analytics' },
  { id: 'deploy', label: 'Vercel Deploy' },
];

export const TopBar: React.FC<TopBarProps> = ({
  activeView,
  onNavigate,
  accountLoginId,
  onOpenConnect,
}) => {
  return (
    <header className="h-14 border-b border-[#E6E9E9] dark:border-[#2A2E30] bg-white dark:bg-[#151717] px-6 flex items-center justify-between gap-8 shrink-0">
      {/* Zone 1: Single-element Brand wordmark */}
      <button
        type="button"
        onClick={() => onNavigate('runner')}
        className="text-lg font-bold tracking-tight text-[#0E0E0E] dark:text-[#F2F3F4] whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-[#FF444F] rounded"
      >
        Deriv<span className="text-[#FF444F]">Bot</span>
      </button>

      {/* Zone 2: 4 single-line nav links */}
      <nav aria-label="Primary Navigation" className="hidden md:flex items-center gap-7">
        {NAV_ITEMS.map((item) => {
          const active = activeView === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onNavigate(item.id)}
              className={`relative py-4 text-sm font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-[#FF444F] ${
                active
                  ? 'text-[#0E0E0E] dark:text-white'
                  : 'text-[#6E757C] dark:text-[#999999] hover:text-[#0E0E0E] dark:hover:text-[#F2F3F4]'
              }`}
            >
              {item.label}
              {active && (
                <span
                  aria-hidden="true"
                  className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#FF444F]"
                />
              )}
            </button>
          );
        })}
      </nav>

      {/* Zone 3: 1 primary action */}
      <div className="shrink-0">
        <button
          type="button"
          onClick={onOpenConnect}
          className="px-4 py-2 text-xs font-semibold text-white bg-[#FF444F] hover:bg-[#EB3E48] rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF444F]"
        >
          {accountLoginId ? `Account · ${accountLoginId}` : 'Connect Deriv'}
        </button>
      </div>
    </header>
  );
};
