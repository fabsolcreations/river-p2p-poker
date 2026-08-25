// Single source of truth for the four stakes tiers, shared by the lobby's
// "New table" dialog, the lounge "Join <tier>" tiles, and the
// /api/lounge/join matchmaking route - previously this array lived only
// inside app/lobby/page.tsx, duplicating what the lounge route would
// otherwise need to know independently.

export type StakesTier = "micro" | "low" | "mid" | "high";

export type StakesPreset = {
  tier: StakesTier;
  label: string;
  smallBlind: number;
  bigBlind: number;
  minBuyIn: number;
  maxBuyIn: number;
};

export const STAKES_PRESETS: StakesPreset[] = [
  { tier: "micro", label: "Micro", smallBlind: 1, bigBlind: 2, minBuyIn: 40, maxBuyIn: 200 },
  { tier: "low", label: "Low", smallBlind: 5, bigBlind: 10, minBuyIn: 200, maxBuyIn: 1000 },
  { tier: "mid", label: "Mid", smallBlind: 25, bigBlind: 50, minBuyIn: 1000, maxBuyIn: 5000 },
  { tier: "high", label: "High", smallBlind: 100, bigBlind: 200, minBuyIn: 4000, maxBuyIn: 20000 },
];

export function stakesPresetForTier(tier: string): StakesPreset | undefined {
  return STAKES_PRESETS.find((preset) => preset.tier === tier);
}
