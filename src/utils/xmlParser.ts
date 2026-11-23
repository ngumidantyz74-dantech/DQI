import {
  BotBlockSummary,
  BotStrategyConfig,
  ContractCategory,
  PurchaseDirection,
  StrategyEngineType,
} from '../types/deriv';

function getFieldText(root: Element, name: string): string | null {
  const fields = root.querySelectorAll(`field[name="${name}"]`);
  for (const field of Array.from(fields)) {
    if (field.textContent !== null) {
      return field.textContent.trim();
    }
  }
  return null;
}

function getVariableSetValue(doc: Document, varNameMatch: string[]): {
  value: string | null;
  disabled: boolean;
} {
  const blocks = Array.from(doc.querySelectorAll('block[type="variables_set"]'));
  for (const block of blocks) {
    const varField = block.querySelector(':scope > field[name="VAR"]');
    const varLabel = varField?.textContent?.trim() || '';
    const matches = varNameMatch.some(
      (candidate) => varLabel.toLowerCase() === candidate.toLowerCase() || varLabel.toLowerCase().includes(candidate.toLowerCase())
    );
    if (!matches) continue;

    const valNode = block.querySelector(':scope > value[name="VALUE"]');
    if (!valNode) continue;

    const boolField = valNode.querySelector('block[type="logic_boolean"] > field[name="BOOL"]');
    if (boolField?.textContent) {
      return { value: boolField.textContent.trim(), disabled: block.getAttribute('disabled') === 'true' };
    }

    const numField = valNode.querySelector('field[name="NUM"]');
    if (numField?.textContent) {
      return { value: numField.textContent.trim(), disabled: block.getAttribute('disabled') === 'true' };
    }
  }
  return { value: null, disabled: false };
}

function parseNumberOrDefault(raw: string | null, fallback: number): number {
  if (raw === null || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseDbotXml(
  xmlString: string,
  meta: { id: string; name: string; fileName: string; sourcePath?: string; description?: string }
): BotStrategyConfig {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, 'text/xml');
  const root = doc.documentElement;

  const variables = Array.from(doc.querySelectorAll('variables > variable')).map(
    (v) => v.textContent?.trim() || ''
  ).filter(Boolean);

  const market = getFieldText(root, 'MARKET_LIST') || 'synthetic_index';
  const submarket = getFieldText(root, 'SUBMARKET_LIST') || 'random_index';
  const symbol = getFieldText(root, 'SYMBOL_LIST') || '1HZ100V';
  const rawCategory = (getFieldText(root, 'TRADETYPECAT_LIST') || 'callput') as ContractCategory;
  const tradeType = getFieldText(root, 'TRADETYPE_LIST') || rawCategory;
  const purchaseType = (getFieldText(root, 'PURCHASE_LIST') || (rawCategory === 'accumulator' ? 'ACCU' : rawCategory === 'digits' ? 'DIGITMATCH' : 'CALL')) as PurchaseDirection;
  const candleInterval = parseNumberOrDefault(getFieldText(root, 'CANDLEINTERVAL_LIST'), 60);
  const growthRate = parseNumberOrDefault(getFieldText(root, 'GROWTHRATE_LIST'), 0.02);

  // Trade options (duration & prediction)
  const tradeOptionsBlock = doc.querySelector('block[type="trade_definition_tradeoptions"]');
  const durationUnit = (tradeOptionsBlock?.querySelector('field[name="DURATIONTYPE_LIST"]')?.textContent?.trim() || 't') as 't' | 's' | 'm';
  const duration = parseNumberOrDefault(
    tradeOptionsBlock?.querySelector('value[name="DURATION"] field[name="NUM"]')?.textContent?.trim() || null,
    1
  );
  const prediction = parseNumberOrDefault(
    tradeOptionsBlock?.querySelector('value[name="PREDICTION"] field[name="NUM"]')?.textContent?.trim() || null,
    1
  );

  // Accumulator take profit
  const accTpBlock = doc.querySelector('block[type="accumulator_take_profit"]');
  const takeProfitEnabled = accTpBlock ? accTpBlock.getAttribute('disabled') !== 'true' : false;
  const takeProfit = parseNumberOrDefault(
    accTpBlock?.querySelector('value[name="AMOUNT"] field[name="NUM"]')?.textContent?.trim() || null,
    10
  );

  // Detect strategy engine
  const procNames = Array.from(doc.querySelectorAll('block[type="procedures_defreturn"] > field[name="NAME"], block[type="procedures_defnoreturn"] > field[name="NAME"]'))
    .map((el) => el.textContent?.trim() || '');

  let engineType: StrategyEngineType = 'custom';
  if (procNames.some((n) => n.toLowerCase().includes('dalembert') || n.toLowerCase().includes("d'alembert")) || variables.some((v) => v.includes('dalembert'))) {
    engineType = 'dalembert';
  } else if (procNames.some((n) => n.toLowerCase().includes('reverse martingale')) || variables.some((v) => v.includes('martingale'))) {
    engineType = 'reverse_martingale';
  } else if (variables.some((v) => v === 'winStep') || procNames.some((n) => n.includes('Win Streak'))) {
    engineType = 'digit_scalper';
  }

  // Extract strategy parameters
  const initialStakeRaw = getVariableSetValue(doc, ['initialStake', 'martingale:initialStake', 'dalembert:initialStake']);
  const profitThresholdRaw = getVariableSetValue(doc, ['profitThreshold', 'martingale:profitThreshold', 'dalembert:profitThreshold']);
  const lossThresholdRaw = getVariableSetValue(doc, ['lossThreshold', 'martingale:lossThreshold', 'dalembert:lossThreshold']);
  const useMaxStakeRaw = getVariableSetValue(doc, ['useMaxStake?']);
  const maxStakeRaw = getVariableSetValue(doc, ['maxStake']);
  const sellByCountdownRaw = getVariableSetValue(doc, ["Sell by 'Count Down'"]);
  const tickCountRaw = getVariableSetValue(doc, ['Tick Count']);
  const winStepRaw = getVariableSetValue(doc, ['winStep']);
  const maxWinStepsRaw = getVariableSetValue(doc, ['maxWinSteps']);
  const sizeRaw = getVariableSetValue(doc, ['martingale:size']);
  const changeInUnitRaw = getVariableSetValue(doc, ['dalembert:changeInUnit']);

  // Build human-readable block summary
  const blocks: BotBlockSummary[] = [
    {
      id: 'blk-trade-def',
      phase: 'Trade Definition',
      name: `${symbol} · ${rawCategory.toUpperCase()}`,
      detail: rawCategory === 'accumulator'
        ? `Growth ${(growthRate * 100).toFixed(0)}% · ${takeProfitEnabled ? `TP $${takeProfit}` : `Countdown / Manual`}`
        : rawCategory === 'digits'
          ? `${purchaseType} digit ${prediction} · ${duration}${durationUnit}`
          : `${purchaseType} · ${duration}${durationUnit} candle ${candleInterval}s`,
    },
  ];

  const initBlock = doc.querySelector('statement[name="INITIALIZATION"]');
  if (initBlock) {
    blocks.push({
      id: 'blk-init',
      phase: 'Initialization',
      name: 'Session Parameters',
      detail: `Base $${parseNumberOrDefault(initialStakeRaw.value, 1)} · TP $${parseNumberOrDefault(profitThresholdRaw.value, 10)} · SL $${parseNumberOrDefault(lossThresholdRaw.value, 5)}`,
    });
  }

  const beforeBlock = doc.querySelector('block[type="before_purchase"]');
  if (beforeBlock) {
    blocks.push({
      id: 'blk-before',
      phase: 'Before Purchase',
      name: `Execute ${purchaseType}`,
      detail: `Resets tick flags, notifies stake, submits ${purchaseType} contract order`,
    });
  }

  const duringBlock = doc.querySelector('block[type="during_purchase"]');
  if (duringBlock) {
    blocks.push({
      id: 'blk-during',
      phase: 'During Purchase',
      name: 'Open Contract Guard',
      detail: `Checks sell availability and optional Tick Count (${parseNumberOrDefault(tickCountRaw.value, 0)} ticks) market exit`,
    });
  }

  const tickBlock = doc.querySelector('block[type="tick_analysis"]');
  if (tickBlock) {
    blocks.push({
      id: 'blk-tick',
      phase: 'Tick Analysis',
      name: 'Live Tick Counter',
      detail: 'Increments Current Tick Value on every incoming price tick while position is open',
    });
  }

  const afterBlock = doc.querySelector('block[type="after_purchase"]');
  if (afterBlock) {
    blocks.push({
      id: 'blk-after',
      phase: 'After Purchase',
      name: 'Result Evaluation & Risk Loop',
      detail:
        engineType === 'digit_scalper'
          ? `Adds +$${parseNumberOrDefault(winStepRaw.value, 0.5)} per win (max ${parseNumberOrDefault(maxWinStepsRaw.value, 3)} steps), resets on loss`
          : engineType === 'reverse_martingale'
            ? `Multiplies stake ×${parseNumberOrDefault(sizeRaw.value, 2)} on win (cap $${parseNumberOrDefault(maxStakeRaw.value, 20)}), resets on loss`
            : `D'Alembert ±${parseNumberOrDefault(changeInUnitRaw.value, 1)} unit(s): -unit on win, +unit on loss`,
    });
  }

  for (const pName of procNames) {
    blocks.push({
      id: `proc-${pName}`,
      phase: 'Procedure',
      name: pName,
      detail: 'Reusable Blockly subroutine',
    });
  }

  const defaultDesc =
    engineType === 'digit_scalper'
      ? `Linear win-streak digit scalper targeting ${purchaseType} (${prediction}) on ${symbol}.`
      : engineType === 'reverse_martingale'
        ? `Compounding winner-scaling Reverse Martingale strategy running ${purchaseType} on ${symbol}.`
        : engineType === 'dalembert'
          ? `Unit-balanced D'Alembert recovery strategy running ${purchaseType} on ${symbol}.`
          : `Custom imported DBot XML strategy on ${symbol}.`;

  return {
    id: meta.id,
    name: meta.name,
    fileName: meta.fileName,
    sourcePath: meta.sourcePath,
    description: meta.description || defaultDesc,
    engineType,
    market,
    submarket,
    symbol,
    tradeTypeCategory: rawCategory,
    tradeType,
    purchaseType,
    candleInterval,
    duration,
    durationUnit,
    prediction,
    growthRate,
    takeProfit,
    takeProfitEnabled,
    sellByCountdown: sellByCountdownRaw.value === 'TRUE',
    tickCount: parseNumberOrDefault(tickCountRaw.value, 0),
    initialStake: parseNumberOrDefault(initialStakeRaw.value, 1),
    profitThreshold: parseNumberOrDefault(profitThresholdRaw.value, 10),
    lossThreshold: parseNumberOrDefault(lossThresholdRaw.value, 5),
    useMaxStake: useMaxStakeRaw.value !== 'FALSE',
    maxStake: parseNumberOrDefault(maxStakeRaw.value, 20),
    winStep: parseNumberOrDefault(winStepRaw.value, 0.5),
    maxWinSteps: parseNumberOrDefault(maxWinStepsRaw.value, 3),
    multiplierSize: parseNumberOrDefault(sizeRaw.value, 2),
    changeInUnit: parseNumberOrDefault(changeInUnitRaw.value, 1),
    variables,
    blocks,
    rawXml: xmlString,
  };
}

export function serializeConfigToXml(config: BotStrategyConfig): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(config.rawXml, 'text/xml');

  const setField = (name: string, val: string) => {
    const fields = doc.querySelectorAll(`field[name="${name}"]`);
    fields.forEach((f) => {
      f.textContent = val;
    });
  };

  setField('SYMBOL_LIST', config.symbol);
  setField('PURCHASE_LIST', config.purchaseType);
  setField('GROWTHRATE_LIST', String(config.growthRate));

  const tradeOptionsBlock = doc.querySelector('block[type="trade_definition_tradeoptions"]');
  if (tradeOptionsBlock) {
    const durField = tradeOptionsBlock.querySelector('value[name="DURATION"] field[name="NUM"]');
    if (durField) durField.textContent = String(config.duration);
    const predField = tradeOptionsBlock.querySelector('value[name="PREDICTION"] field[name="NUM"]');
    if (predField) predField.textContent = String(config.prediction);
  }

  const accTpBlock = doc.querySelector('block[type="accumulator_take_profit"]');
  if (accTpBlock) {
    if (config.takeProfitEnabled) {
      accTpBlock.removeAttribute('disabled');
    } else {
      accTpBlock.setAttribute('disabled', 'true');
    }
    const tpNum = accTpBlock.querySelector('value[name="AMOUNT"] field[name="NUM"]');
    if (tpNum) tpNum.textContent = String(config.takeProfit);
  }

  const updateVar = (candidates: string[], val: string, isBool = false) => {
    const blocks = Array.from(doc.querySelectorAll('block[type="variables_set"]'));
    for (const block of blocks) {
      const varLabel = block.querySelector(':scope > field[name="VAR"]')?.textContent?.trim() || '';
      if (!candidates.some((c) => varLabel.toLowerCase() === c.toLowerCase() || varLabel.toLowerCase().includes(c.toLowerCase()))) {
        continue;
      }
      const valNode = block.querySelector(':scope > value[name="VALUE"]');
      if (!valNode) continue;
      if (isBool) {
        const b = valNode.querySelector('field[name="BOOL"]');
        if (b) b.textContent = val;
      } else {
        const n = valNode.querySelector('field[name="NUM"]');
        if (n) n.textContent = val;
      }
    }
  };

  updateVar(['initialStake', 'martingale:initialStake', 'dalembert:initialStake'], String(config.initialStake));
  updateVar(['profitThreshold', 'martingale:profitThreshold', 'dalembert:profitThreshold'], String(config.profitThreshold));
  updateVar(['lossThreshold', 'martingale:lossThreshold', 'dalembert:lossThreshold'], String(config.lossThreshold));
  updateVar(['maxStake'], String(config.maxStake));
  updateVar(['useMaxStake?'], config.useMaxStake ? 'TRUE' : 'FALSE', true);
  updateVar(["Sell by 'Count Down'"], config.sellByCountdown ? 'TRUE' : 'FALSE', true);
  updateVar(['Tick Count'], String(config.tickCount));
  updateVar(['winStep'], String(config.winStep));
  updateVar(['maxWinSteps'], String(config.maxWinSteps));
  updateVar(['martingale:size'], String(config.multiplierSize));
  updateVar(['dalembert:changeInUnit'], String(config.changeInUnit));

  return new XMLSerializer().serializeToString(doc);
}
