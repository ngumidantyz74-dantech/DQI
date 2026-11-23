import { useCallback, useEffect, useRef, useState } from 'react';
import { derivService } from '../services/derivWs';
import {
  BotJournalEntry,
  BotStrategyConfig,
  DERIV_SYMBOLS,
  DerivAccount,
  ExecutedTrade,
  LiveTick,
} from '../types/deriv';

export interface ActiveContractState {
  contractId: string;
  entrySpot: number;
  lastSpot: number;
  stake: number;
  currentValue: number;
  currentProfit: number;
  ticksHeld: number;
  highBarrier?: number;
  lowBarrier?: number;
  openedAt: number;
  realContractMode: boolean;
}

export interface BotSessionState {
  isRunning: boolean;
  tradesCount: number;
  wins: number;
  losses: number;
  totalProfit: number;
  currentStake: number;
  winStreak: number;
  multiplier: number;
  dalembertUnits: number;
  paperBalance: number;
  activeContract: ActiveContractState | null;
  stopReason: string | null;
}

function nowTimeStr(): string {
  return new Date().toISOString().slice(11, 19);
}

export function computeNextStake(
  strategy: BotStrategyConfig,
  winStreak: number,
  multiplier: number,
  dalembertUnits: number
): number {
  let stake = strategy.initialStake;
  if (strategy.engineType === 'digit_scalper') {
    stake = strategy.initialStake + winStreak * strategy.winStep;
  } else if (strategy.engineType === 'reverse_martingale') {
    stake = strategy.initialStake * multiplier;
  } else if (strategy.engineType === 'dalembert') {
    stake = strategy.initialStake * dalembertUnits;
  }
  if (strategy.useMaxStake && stake > strategy.maxStake) {
    stake = strategy.initialStake;
  }
  return Number(Math.max(0.35, stake).toFixed(2));
}

export function useBotEngine(
  strategy: BotStrategyConfig | null,
  latestTick: LiveTick | null,
  executionMode: 'paper' | 'deriv-live',
  account: DerivAccount | null,
  onAccountBalanceUpdate?: (newBalance: number) => void
) {
  const [session, setSession] = useState<BotSessionState>({
    isRunning: false,
    tradesCount: 0,
    wins: 0,
    losses: 0,
    totalProfit: 0,
    currentStake: strategy?.initialStake ?? 1,
    winStreak: 0,
    multiplier: 1,
    dalembertUnits: 1,
    paperBalance: 10000,
    activeContract: null,
    stopReason: null,
  });

  const [trades, setTrades] = useState<ExecutedTrade[]>([]);
  const [journal, setJournal] = useState<BotJournalEntry[]>([]);

  const stateRef = useRef(session);
  stateRef.current = session;

  const strategyRef = useRef(strategy);
  strategyRef.current = strategy;

  const modeRef = useRef(executionMode);
  modeRef.current = executionMode;

  const accountRef = useRef(account);
  accountRef.current = account;

  const buyingLockRef = useRef(false);
  const lastProcessedEpochRef = useRef<number>(0);

  const pushJournal = useCallback((type: BotJournalEntry['type'], message: string) => {
    setJournal((prev) => [
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        time: nowTimeStr(),
        type,
        message,
      },
      ...prev.slice(0, 149),
    ]);
  }, []);

  // Reset currentStake preview when strategy changes and bot is idle
  useEffect(() => {
    if (!strategy || stateRef.current.isRunning) return;
    setSession((prev) => ({
      ...prev,
      currentStake: strategy.initialStake,
    }));
  }, [strategy]);

  const settleContract = useCallback(
    (params: {
      contractId: string;
      stake: number;
      payout: number;
      entrySpot: number;
      exitSpot: number;
      barrier?: number;
      ticksHeld: number;
      exitDigit?: number;
    }) => {
      const strat = strategyRef.current;
      if (!strat) return;

      const profit = Number((params.payout - params.stake).toFixed(2));
      const isWin = profit > 0;
      const cur = stateRef.current;

      const nextTotalProfit = Number((cur.totalProfit + profit).toFixed(2));
      let nextWinStreak = cur.winStreak;
      let nextMultiplier = cur.multiplier;
      let nextUnits = cur.dalembertUnits;
      let resetNotice: string | null = null;

      if (strat.engineType === 'digit_scalper') {
        if (isWin) {
          nextWinStreak += 1;
          if (nextWinStreak > strat.maxWinSteps) {
            nextWinStreak = 0;
            resetNotice = `Win streak reached max steps (${strat.maxWinSteps}); stake reset to $${strat.initialStake.toFixed(2)}.`;
          }
        } else {
          nextWinStreak = 0;
        }
      } else if (strat.engineType === 'reverse_martingale') {
        if (isWin) {
          nextMultiplier = Number((nextMultiplier * strat.multiplierSize).toFixed(4));
          if (strat.useMaxStake && strat.initialStake * nextMultiplier > strat.maxStake) {
            nextMultiplier = 1;
            resetNotice = `Next stake exceeds max stake ($${strat.maxStake}); multiplier reset to 1x.`;
          }
        } else {
          nextMultiplier = 1;
        }
      } else if (strat.engineType === 'dalembert') {
        if (isWin) {
          nextUnits = Math.max(1, nextUnits - strat.changeInUnit);
        } else {
          nextUnits = nextUnits + strat.changeInUnit;
          if (strat.useMaxStake && strat.initialStake * nextUnits > strat.maxStake) {
            nextUnits = 1;
            resetNotice = `Next stake exceeds max stake ($${strat.maxStake}); units reset to 1.`;
          }
        }
      }

      const nextStake = computeNextStake(strat, nextWinStreak, nextMultiplier, nextUnits);

      let shouldStop = false;
      let stopReason: string | null = null;
      if (nextTotalProfit >= strat.profitThreshold) {
        shouldStop = true;
        stopReason = `Profit threshold triggered (+$${nextTotalProfit.toFixed(2)} >= $${strat.profitThreshold.toFixed(2)})`;
      } else if (nextTotalProfit <= -strat.lossThreshold) {
        shouldStop = true;
        stopReason = `Loss threshold triggered (-$${Math.abs(nextTotalProfit).toFixed(2)} >= $${strat.lossThreshold.toFixed(2)})`;
      }

      const tradeRecord: ExecutedTrade = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        contractId: params.contractId,
        strategyId: strat.id,
        strategyName: strat.name,
        symbol: strat.symbol,
        contractType: strat.purchaseType,
        buyPrice: params.stake,
        payout: Number(params.payout.toFixed(2)),
        profit,
        isWin,
        entrySpot: params.entrySpot,
        exitSpot: params.exitSpot,
        barrier: params.barrier,
        ticksHeld: params.ticksHeld,
        prediction: strat.tradeTypeCategory === 'digits' ? strat.prediction : undefined,
        exitDigit: params.exitDigit,
        timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' GMT',
        mode: modeRef.current,
      };

      setTrades((prev) => [tradeRecord, ...prev]);

      pushJournal(
        isWin ? 'success' : 'error',
        `${strat.purchaseType} settled: ${isWin ? 'WIN' : 'LOSS'} ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)} · Session P/L: ${nextTotalProfit >= 0 ? '+' : ''}$${nextTotalProfit.toFixed(2)}`
      );
      if (resetNotice) {
        pushJournal('warn', resetNotice);
      }
      if (stopReason) {
        pushJournal(nextTotalProfit >= 0 ? 'success' : 'error', stopReason);
      }

      setSession((prev) => ({
        ...prev,
        isRunning: shouldStop ? false : prev.isRunning,
        tradesCount: prev.tradesCount + 1,
        wins: prev.wins + (isWin ? 1 : 0),
        losses: prev.losses + (isWin ? 0 : 1),
        totalProfit: nextTotalProfit,
        currentStake: nextStake,
        winStreak: nextWinStreak,
        multiplier: nextMultiplier,
        dalembertUnits: nextUnits,
        paperBalance:
          modeRef.current === 'paper'
            ? Number((prev.paperBalance + profit).toFixed(2))
            : prev.paperBalance,
        activeContract: null,
        stopReason,
      }));
    },
    [pushJournal]
  );

  // Process incoming ticks for active contracts & opening next contract
  useEffect(() => {
    if (!latestTick || !strategyRef.current) return;
    if (latestTick.symbol !== strategyRef.current.symbol) return;

    const tickKey = latestTick.epoch * 1000 + Math.round(latestTick.quote * 100);
    if (tickKey === lastProcessedEpochRef.current) return;
    lastProcessedEpochRef.current = tickKey;

    const strat = strategyRef.current;
    const cur = stateRef.current;

    // 1. If there is an active Paper contract, advance it on this tick
    if (cur.activeContract && !cur.activeContract.realContractMode) {
      const ac = cur.activeContract;
      const nextTicksHeld = ac.ticksHeld + 1;

      if (strat.tradeTypeCategory === 'accumulator') {
        const info = DERIV_SYMBOLS[strat.symbol] || DERIV_SYMBOLS['1HZ100V'];
        // Realistic barrier bandwidth based on index tick volatility & growth rate
        const maxMove = info.volatilityFactor * (strat.growthRate <= 0.01 ? 2.4 : strat.growthRate <= 0.02 ? 1.85 : 1.45);
        const tickMove = Math.abs(latestTick.quote - ac.lastSpot);
        const knockedOut = tickMove > maxMove;

        if (knockedOut) {
          settleContract({
            contractId: ac.contractId,
            stake: ac.stake,
            payout: 0,
            entrySpot: ac.entrySpot,
            exitSpot: latestTick.quote,
            barrier: Number((ac.lastSpot + maxMove).toFixed(info.pipSize)),
            ticksHeld: nextTicksHeld,
          });
          return;
        }

        const nextVal = Number((ac.currentValue * (1 + strat.growthRate)).toFixed(2));
        const nextProfit = Number((nextVal - ac.stake).toFixed(2));
        const hitTakeProfit = strat.takeProfitEnabled && nextProfit >= strat.takeProfit;
        const hitCountdown = strat.sellByCountdown && nextTicksHeld > strat.tickCount;

        if (hitTakeProfit || hitCountdown) {
          settleContract({
            contractId: ac.contractId,
            stake: ac.stake,
            payout: nextVal,
            entrySpot: ac.entrySpot,
            exitSpot: latestTick.quote,
            barrier: Number((latestTick.quote + maxMove).toFixed(info.pipSize)),
            ticksHeld: nextTicksHeld,
          });
          return;
        }

        setSession((prev) => ({
          ...prev,
          activeContract: prev.activeContract
            ? {
                ...prev.activeContract,
                lastSpot: latestTick.quote,
                currentValue: nextVal,
                currentProfit: nextProfit,
                ticksHeld: nextTicksHeld,
                highBarrier: Number((latestTick.quote + maxMove).toFixed(info.pipSize)),
                lowBarrier: Number((latestTick.quote - maxMove).toFixed(info.pipSize)),
              }
            : null,
        }));
        return;
      }

      // Digits or Call/Put tick duration settlement
      if (nextTicksHeld >= strat.duration) {
        let isWin = false;
        let payout = 0;

        if (strat.purchaseType === 'CALL') {
          isWin = latestTick.quote > ac.entrySpot;
          payout = isWin ? ac.stake * 1.9 : 0;
        } else if (strat.purchaseType === 'PUT') {
          isWin = latestTick.quote < ac.entrySpot;
          payout = isWin ? ac.stake * 1.9 : 0;
        } else if (strat.purchaseType === 'DIGITMATCH') {
          isWin = latestTick.lastDigit === strat.prediction;
          payout = isWin ? ac.stake * 9.0 : 0;
        } else if (strat.purchaseType === 'DIGITDIFF') {
          isWin = latestTick.lastDigit !== strat.prediction;
          payout = isWin ? ac.stake * 1.095 : 0;
        }

        settleContract({
          contractId: ac.contractId,
          stake: ac.stake,
          payout,
          entrySpot: ac.entrySpot,
          exitSpot: latestTick.quote,
          barrier: ac.entrySpot,
          ticksHeld: nextTicksHeld,
          exitDigit: latestTick.lastDigit,
        });
      } else {
        setSession((prev) => ({
          ...prev,
          activeContract: prev.activeContract
            ? {
                ...prev.activeContract,
                lastSpot: latestTick.quote,
                ticksHeld: nextTicksHeld,
              }
            : null,
        }));
      }
      return;
    }

    // 2. If running & no active contract, open the next trade!
    if (cur.isRunning && !cur.activeContract && !buyingLockRef.current) {
      const stake = computeNextStake(strat, cur.winStreak, cur.multiplier, cur.dalembertUnits);

      if (modeRef.current === 'deriv-live' && accountRef.current) {
        buyingLockRef.current = true;
        pushJournal('info', `Submitting live Deriv ${strat.purchaseType} order ($${stake.toFixed(2)}) on ${strat.symbol}...`);
        derivService
          .buyRealContract({
            symbol: strat.symbol,
            contractType: strat.purchaseType,
            amount: stake,
            duration: strat.duration,
            durationUnit: strat.durationUnit,
            prediction: strat.prediction,
            growthRate: strat.growthRate,
            takeProfit: strat.takeProfit,
            takeProfitEnabled: strat.takeProfitEnabled,
          })
          .then((bought) => {
            buyingLockRef.current = false;
            setSession((prev) => ({
              ...prev,
              activeContract: {
                contractId: bought.contractId,
                entrySpot: latestTick.quote,
                lastSpot: latestTick.quote,
                stake: bought.buyPrice,
                currentValue: bought.buyPrice,
                currentProfit: 0,
                ticksHeld: 0,
                openedAt: Date.now(),
                realContractMode: true,
              },
            }));

            // Poll contract status until settled
            const pollId = window.setInterval(async () => {
              try {
                const poc = await derivService.getContractStatus(bought.contractId);
                if (!poc) return;

                if (poc.is_sold) {
                  window.clearInterval(pollId);
                  if (onAccountBalanceUpdate && typeof poc.account_balance === 'number') {
                    onAccountBalanceUpdate(poc.account_balance);
                  }
                  settleContract({
                    contractId: bought.contractId,
                    stake: Number(poc.buy_price || bought.buyPrice),
                    payout: Number(poc.sell_price || 0),
                    entrySpot: Number(poc.entry_spot || latestTick.quote),
                    exitSpot: Number(poc.exit_tick || poc.current_spot || latestTick.quote),
                    barrier: poc.barrier ? Number(poc.barrier) : undefined,
                    ticksHeld: Number(poc.tick_count || strat.duration),
                  });
                } else {
                  const curSpot = Number(poc.current_spot || latestTick.quote);
                  const bidPrice = Number(poc.bid_price || bought.buyPrice);
                  const curTicks = Number(poc.tick_passed || 0);
                  setSession((prev) => ({
                    ...prev,
                    activeContract: prev.activeContract
                      ? {
                          ...prev.activeContract,
                          lastSpot: curSpot,
                          currentValue: bidPrice,
                          currentProfit: Number((bidPrice - bought.buyPrice).toFixed(2)),
                          ticksHeld: curTicks,
                        }
                      : null,
                  }));

                  if (
                    strat.tradeTypeCategory === 'accumulator' &&
                    strat.sellByCountdown &&
                    curTicks > strat.tickCount &&
                    poc.is_valid_to_sell
                  ) {
                    await derivService.sellContract(bought.contractId);
                  }
                }
              } catch {
                window.clearInterval(pollId);
              }
            }, 900);
          })
          .catch((err: Error) => {
            buyingLockRef.current = false;
            pushJournal('error', `Deriv execution error: ${err.message}`);
            setSession((prev) => ({
              ...prev,
              isRunning: false,
              stopReason: err.message,
            }));
          });
      } else {
        // Paper execution on live ticks
        const info = DERIV_SYMBOLS[strat.symbol] || DERIV_SYMBOLS['1HZ100V'];
        const maxMove = info.volatilityFactor * 1.85;
        const contractId = `SIM-${Math.floor(41195000000 + Math.random() * 900000)}`;
        pushJournal(
          'info',
          `Opened ${strat.purchaseType} on ${strat.symbol} · Stake $${stake.toFixed(2)} @ ${latestTick.quote.toFixed(info.pipSize)}`
        );
        setSession((prev) => ({
          ...prev,
          activeContract: {
            contractId,
            entrySpot: latestTick.quote,
            lastSpot: latestTick.quote,
            stake,
            currentValue: stake,
            currentProfit: 0,
            ticksHeld: 0,
            highBarrier:
              strat.tradeTypeCategory === 'accumulator'
                ? Number((latestTick.quote + maxMove).toFixed(info.pipSize))
                : undefined,
            lowBarrier:
              strat.tradeTypeCategory === 'accumulator'
                ? Number((latestTick.quote - maxMove).toFixed(info.pipSize))
                : undefined,
            openedAt: Date.now(),
            realContractMode: false,
          },
        }));
      }
    }
  }, [latestTick, onAccountBalanceUpdate, pushJournal, settleContract]);

  const startBot = useCallback(() => {
    if (!strategy) return;
    if (executionMode === 'deriv-live' && !account) {
      pushJournal('error', 'Connect a Deriv account via OAuth before starting Live Account execution.');
      return;
    }
    pushJournal(
      'info',
      `Started ${strategy.name} (${strategy.symbol} · ${strategy.purchaseType}) in ${executionMode === 'deriv-live' ? `Deriv Account (${account?.loginid})` : 'Live-Tick Paper'} mode.`
    );
    setSession((prev) => ({
      ...prev,
      isRunning: true,
      totalProfit: 0,
      tradesCount: 0,
      wins: 0,
      losses: 0,
      winStreak: 0,
      multiplier: 1,
      dalembertUnits: 1,
      currentStake: strategy.initialStake,
      stopReason: null,
    }));
  }, [account, executionMode, pushJournal, strategy]);

  const stopBot = useCallback(() => {
    pushJournal('warn', 'Bot stopped by trader.');
    setSession((prev) => ({
      ...prev,
      isRunning: false,
      stopReason: 'Stopped manually',
    }));
  }, [pushJournal]);

  const manualSellAtMarket = useCallback(async () => {
    const ac = stateRef.current.activeContract;
    if (!ac) return;
    if (ac.realContractMode) {
      try {
        await derivService.sellContract(ac.contractId);
        pushJournal('info', `Sold contract ${ac.contractId} at market.`);
      } catch (err: any) {
        pushJournal('error', `Sell failed: ${err.message}`);
      }
    } else {
      settleContract({
        contractId: ac.contractId,
        stake: ac.stake,
        payout: ac.currentValue,
        entrySpot: ac.entrySpot,
        exitSpot: ac.lastSpot,
        ticksHeld: ac.ticksHeld,
      });
    }
  }, [pushJournal, settleContract]);

  const resetHistory = useCallback(() => {
    setTrades([]);
    setJournal([]);
    setSession((prev) => ({
      ...prev,
      tradesCount: 0,
      wins: 0,
      losses: 0,
      totalProfit: 0,
      winStreak: 0,
      multiplier: 1,
      dalembertUnits: 1,
      currentStake: strategy?.initialStake ?? 1,
      stopReason: null,
    }));
  }, [strategy]);

  return {
    session,
    trades,
    journal,
    startBot,
    stopBot,
    manualSellAtMarket,
    resetHistory,
  };
}
