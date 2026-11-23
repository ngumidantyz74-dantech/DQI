import { GoogleGenAI, Type, type GenerateContentResponse } from '@google/genai';

export interface AiAnalyzeBriefInput {
  symbol: string;
  spotQuote: string | null;
  latestDigit: number | null;
  tickWindowCount: number;
  volatilityRegime: string;
  evenPct: number;
  oddPct: number;
  over4Pct: number;
  under5Pct: number;
  hottestDigit: { digit: number; pct: number } | null;
  coldestDigit: { digit: number; pct: number } | null;
  matchBreakEvenPct: number | null;
  differBreakEvenPct: number | null;
  quantDirection: string | null;
  quantConfidencePct: number | null;
  quantRegime: string | null;
  rsi14: number | null;
}

export interface AiAnalyzeBriefOutput {
  headline: string;
  verdict: 'RISE_BIAS' | 'FALL_BIAS' | 'EVEN_ODD_WATCH' | 'DIFFER_WATCH' | 'WAIT_BALANCED';
  plainSummary: string;
  bestSetup: string;
  whyBullets: string[];
  beginnerTip: string;
  generatedAt: string;
  model: string;
}

function getAiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured in Settings > Secrets.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export async function generateAiMarketBrief(input: AiAnalyzeBriefInput): Promise<AiAnalyzeBriefOutput> {
  const ai = getAiClient();

  const prompt = [
    `Analyze this live Deriv market telemetry for a beginner trader:`,
    `Symbol: ${input.symbol}`,
    `Current Spot Price: ${input.spotQuote ?? 'Unavailable'}`,
    `Latest Observed Last Digit: ${input.latestDigit !== null ? input.latestDigit : 'Unavailable'}`,
    `Tick Sample Analyzed: ${input.tickWindowCount} ticks`,
    `Tick Volatility Regime: ${input.volatilityRegime}`,
    `Even vs Odd Split: Even ${input.evenPct.toFixed(1)}% / Odd ${input.oddPct.toFixed(1)}%`,
    `Over 4 vs Under 5 Split: Over 4 ${input.over4Pct.toFixed(1)}% / Under 5 ${input.under5Pct.toFixed(1)}%`,
    `Most Frequent Recent Digit: ${input.hottestDigit ? `Digit ${input.hottestDigit.digit} (${input.hottestDigit.pct.toFixed(1)}%)` : 'N/A'}`,
    `Least Frequent Recent Digit: ${input.coldestDigit ? `Digit ${input.coldestDigit.digit} (${input.coldestDigit.pct.toFixed(1)}%)` : 'N/A'}`,
    `Live Match Break-Even Win Rate Needed: ${input.matchBreakEvenPct !== null ? `${input.matchBreakEvenPct.toFixed(1)}%` : 'N/A'}`,
    `Live Differ Break-Even Win Rate Needed: ${input.differBreakEvenPct !== null ? `${input.differBreakEvenPct.toFixed(1)}%` : 'N/A'}`,
    `Trend Quant Signal: ${input.quantDirection ?? 'Unavailable'} (${input.quantConfidencePct !== null ? `${input.quantConfidencePct.toFixed(0)}% confidence` : 'N/A'}, Regime: ${input.quantRegime ?? 'N/A'}, RSI14: ${input.rsi14 !== null ? input.rsi14.toFixed(1) : 'N/A'})`,
  ].join('\n');

  const response: GenerateContentResponse = await ai.models.generateContent({
    model: 'gemini-4-hydrogen',
    contents: prompt,
    config: {
      systemInstruction:
        'You are a careful, plain-English market analyst assistant inside a Deriv trading simulator. ' +
        'Explain ONLY what the provided numbers show in simple language a complete beginner understands. ' +
        'NEVER invent numbers not present in the prompt, NEVER claim guaranteed profits, and NEVER claim the current last digit predicts the next digit. ' +
        'Keep the headline under 12 words, summary under 40 words, each bullet under 18 words, and include 1 practical risk tip.',
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          headline: { type: Type.STRING, description: 'Short plain-English verdict headline under 12 words.' },
          verdict: {
            type: Type.STRING,
            description: 'One of RISE_BIAS, FALL_BIAS, EVEN_ODD_WATCH, DIFFER_WATCH, or WAIT_BALANCED.',
          },
          plainSummary: { type: Type.STRING, description: 'Two simple sentences explaining current market state for a beginner.' },
          bestSetup: { type: Type.STRING, description: 'Suggested practice setup name or Wait (No clear edge).' },
          whyBullets: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Exactly 3 short bullets citing the real numbers provided.',
          },
          beginnerTip: { type: Type.STRING, description: 'One concise discipline or stake-sizing tip.' },
        },
        required: ['headline', 'verdict', 'plainSummary', 'bestSetup', 'whyBullets', 'beginnerTip'],
      },
    },
  });

  const text = (response.text ?? '{}').trim();
  const parsed = JSON.parse(text) as Partial<AiAnalyzeBriefOutput>;

  const validVerdicts = new Set([
    'RISE_BIAS',
    'FALL_BIAS',
    'EVEN_ODD_WATCH',
    'DIFFER_WATCH',
    'WAIT_BALANCED',
  ]);
  const verdict =
    parsed.verdict && validVerdicts.has(parsed.verdict)
      ? parsed.verdict
      : 'WAIT_BALANCED';

  return {
    headline: String(parsed.headline || 'Live market telemetry analyzed'),
    verdict,
    plainSummary: String(parsed.plainSummary || 'Live tick and trend metrics have been reviewed.'),
    bestSetup: String(parsed.bestSetup || 'Wait for a clearer setup'),
    whyBullets: Array.isArray(parsed.whyBullets) ? parsed.whyBullets.slice(0, 4).map(String) : [],
    beginnerTip: String(parsed.beginnerTip || 'Practice with $1 virtual stakes first and never chase losses.'),
    generatedAt: new Date().toISOString(),
    model: 'gemini-4-hydrogen',
  };
}
