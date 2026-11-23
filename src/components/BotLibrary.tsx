import React, { useState } from 'react';
import { Code2, Copy, Check, Download, Play, Upload } from 'lucide-react';
import { BotStrategyConfig } from '../types/deriv';
import { serializeConfigToXml } from '../utils/xmlParser';

interface BotLibraryProps {
  strategies: BotStrategyConfig[];
  selectedId: string;
  onSelectAndRun: (id: string) => void;
  onUploadXml: (file: File) => void;
}

export const BotLibrary: React.FC<BotLibraryProps> = ({
  strategies,
  selectedId,
  onSelectAndRun,
  onUploadXml,
}) => {
  const [inspectId, setInspectId] = useState<string>(selectedId || strategies[0]?.id || '');
  const [showRawXml, setShowRawXml] = useState(false);
  const [copied, setCopied] = useState(false);

  const active = strategies.find((s) => s.id === inspectId) || strategies[0];

  const handleCopyXml = async () => {
    if (!active) return;
    const xml = serializeConfigToXml(active);
    await navigator.clipboard.writeText(xml);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const handleDownloadXml = () => {
    if (!active) return;
    const xml = serializeConfigToXml(active);
    const blob = new Blob([xml], { type: 'application/xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = active.fileName;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-[#0E0E0E] dark:text-white">
            DBot XML Strategy Library
          </h1>
          <p className="text-xs text-[#6E757C] dark:text-[#999999] mt-0.5">
            Parsed Blockly XML definitions ready for live execution or Deriv Bot export
          </p>
        </div>

        <label className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-[#FF444F] hover:bg-[#EB3E48] rounded transition-colors cursor-pointer whitespace-nowrap">
          <Upload className="w-3.5 h-3.5" />
          Upload DBot XML
          <input
            type="file"
            accept=".xml"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onUploadXml(f);
              e.currentTarget.value = '';
            }}
          />
        </label>
      </div>

      {/* Strategy Overview Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        {strategies.map((s) => {
          const isInspected = active?.id === s.id;
          return (
            <div
              key={s.id}
              onClick={() => setInspectId(s.id)}
              className={`p-4 rounded border transition-colors cursor-pointer flex flex-col justify-between bg-white dark:bg-[#151717] ${
                isInspected
                  ? 'border-[#FF444F]'
                  : 'border-[#E6E9E9] dark:border-[#2A2E30] hover:border-[#999999]'
              }`}
            >
              <div>
                <div className="text-xs font-mono text-[#6E757C] dark:text-[#999999] truncate">
                  {s.symbol} · {s.purchaseType}
                </div>
                <h3 className="text-sm font-semibold text-[#0E0E0E] dark:text-white mt-1">
                  {s.name}
                </h3>
                <p className="text-xs text-[#6E757C] dark:text-[#999999] mt-2 line-clamp-3 leading-relaxed">
                  {s.description}
                </p>
              </div>

              <div className="mt-4 pt-3 border-t border-[#E6E9E9] dark:border-[#2A2E30] flex items-center justify-between gap-2">
                <span className="text-xs font-mono tabular-nums text-[#333333] dark:text-[#C2C5C7]">
                  ${s.initialStake} · TP ${s.profitThreshold} / SL ${s.lossThreshold}
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectAndRun(s.id);
                  }}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-[#FF444F] hover:text-[#EB3E48] whitespace-nowrap cursor-pointer"
                >
                  <Play className="w-3 h-3 fill-current" />
                  Load
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Detailed Blockly Architecture Inspector */}
      {active && (
        <div className="bg-white dark:bg-[#151717] border border-[#E6E9E9] dark:border-[#2A2E30] rounded p-5 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-[#E6E9E9] dark:border-[#2A2E30]">
            <div>
              <h2 className="text-base font-semibold text-[#0E0E0E] dark:text-white">
                {active.name} — Parsed Block Architecture
              </h2>
              <p className="text-xs font-mono text-[#6E757C] dark:text-[#999999] mt-0.5">
                {active.fileName} · {active.variables.length} XML variables · {active.blocks.length} execution stages
              </p>
            </div>

            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={() => setShowRawXml((v) => !v)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded border border-[#E6E9E9] dark:border-[#2A2E30] text-[#333333] dark:text-[#C2C5C7] hover:text-[#0E0E0E] dark:hover:text-white cursor-pointer"
              >
                <Code2 className="w-3.5 h-3.5" />
                {showRawXml ? 'Block Flow' : 'View XML'}
              </button>

              <button
                type="button"
                onClick={handleCopyXml}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded border border-[#E6E9E9] dark:border-[#2A2E30] text-[#333333] dark:text-[#C2C5C7] hover:text-[#0E0E0E] dark:hover:text-white cursor-pointer"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-[#4BB4B3]" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? 'Copied' : 'Copy XML'}
              </button>

              <button
                type="button"
                onClick={handleDownloadXml}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded border border-[#E6E9E9] dark:border-[#2A2E30] text-[#333333] dark:text-[#C2C5C7] hover:text-[#0E0E0E] dark:hover:text-white cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                Download
              </button>

              <button
                type="button"
                onClick={() => onSelectAndRun(active.id)}
                className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold text-white bg-[#FF444F] hover:bg-[#EB3E48] rounded cursor-pointer"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                Open in Runner
              </button>
            </div>
          </div>

          {showRawXml ? (
            <pre className="p-4 rounded bg-[#F8F9FA] dark:bg-[#0E0E0E] border border-[#E6E9E9] dark:border-[#2A2E30] text-[11px] font-mono text-[#333333] dark:text-[#C2C5C7] overflow-x-auto max-h-96 leading-relaxed">
              {serializeConfigToXml(active)}
            </pre>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
              {/* Blockly Stages Table */}
              <div className="lg:col-span-2 overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-[#E6E9E9] dark:border-[#2A2E30] text-[#6E757C] dark:text-[#999999]">
                      <th className="text-left font-medium py-2 pr-3">Block Phase</th>
                      <th className="text-left font-medium py-2 pr-3">Block Name</th>
                      <th className="text-left font-medium py-2">Execution Logic</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#E6E9E9] dark:divide-[#222527]">
                    {active.blocks.map((blk) => (
                      <tr key={blk.id}>
                        <td className="py-2.5 pr-3 font-mono text-[11px] text-[#FF444F] whitespace-nowrap">
                          {blk.phase}
                        </td>
                        <td className="py-2.5 pr-3 font-medium text-[#0E0E0E] dark:text-white whitespace-nowrap">
                          {blk.name}
                        </td>
                        <td className="py-2.5 text-[#333333] dark:text-[#C2C5C7]">{blk.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Variables & Risk Summary */}
              <div className="space-y-4">
                <div>
                  <h3 className="text-xs font-semibold text-[#0E0E0E] dark:text-white mb-2">
                    Declared XML Variables
                  </h3>
                  <div className="p-3 rounded bg-[#F8F9FA] dark:bg-[#0E0E0E] border border-[#E6E9E9] dark:border-[#2A2E30] font-mono text-[11px] text-[#333333] dark:text-[#C2C5C7] space-y-1 max-h-60 overflow-y-auto">
                    {active.variables.map((v, i) => (
                      <div key={i} className="truncate">
                        {v}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
