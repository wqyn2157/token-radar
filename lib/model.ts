// Token launch radar: the valuation and farming model.
//
// One sealed DefiLlama snapshot goes in; a ranked board of pre-token protocols comes out. The board
// covers the snapshot's whole watchlist and keeps going below its floor, because the watchlist is a
// starting line, not a ranking: the same eligibility rule that built the watchlist (records no token,
// not a wrapped, staked or bridged product of one that trades, not an exchange, not a versioned pool)
// is applied to every protocol under the floor, largest first.
//
// The implied value of a launch is built only from the snapshot's own numbers:
//
//   multiple   the market-cap-to-TVL ratio of the protocols that already trade. For a protocol's own
//              category the median ratio of its tokenised peers is shrunk toward the all-market
//              median by the peer count, then clamped to a sane band: a category with two wild
//              peers must not mint a fantasy multiple, and a category with thirty peers speaks
//              mostly for itself.
//   base       = tvl_usd x multiple
//   momentum   = 1 + 0.6 x clamp(change_7d, -50, +100) / 100     (a week of TVL flow, damped)
//   maturity   = 0.80 + 0.35 x min(age_days, 1095) / 1095        (time tracked with no token yet)
//   reach      = 1 + 0.04 x (chains - 1), at most 1.25           (a launch lands on every chain)
//   implied    = max(1, round(base x momentum x maturity x reach))
//
// Nothing is keyed to a protocol's name: one function scores every row, and every row carries the
// figures its value came from, so a reader can recompute any line of the board by hand.

/** One protocol of the sealed snapshot: exactly the ten fields the input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The snapshot document as the radar reads it. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** Why a snapshot text is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

/** The model's fixed constants, stated on the dashboard so the claim can be checked. */
export const MODEL_VERSION = 'radar-2';
export const SHRINK_PEERS = 6;
export const RATIO_FLOOR = 0.03;
export const RATIO_CAP = 2.5;
export const MOMENTUM_WEIGHT = 0.6;
export const MOMENTUM_MIN = -50;
export const MOMENTUM_MAX = 100;
export const MATURITY_BASE = 0.8;
export const MATURITY_SPAN = 0.35;
export const MATURITY_DAYS = 1095;
export const UNKNOWN_AGE_DAYS = 365;
export const REACH_PER_CHAIN = 0.04;
export const REACH_CAP = 1.25;
/** How many live-token protocols the dashboard's "already trading" view carries. */
export const LIVE_ROWS = 24;

const DAY_MS = 86_400_000;

/** Whole days from `listedAt` to `asOf`, never negative; null when a date is missing or unparseable. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const end = Date.parse(`${asOf}T00:00:00Z`);
  const start = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(end) || !Number.isFinite(start)) return null;
  return Math.max(0, Math.floor((end - start) / DAY_MS));
}

/** A protocol records no token when all three token fields are empty. */
export function recordsNoToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

const VERSIONED_NAME = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;
/** Categories that are a product of another protocol's asset, or an exchange: never a launch of their own. */
const PRODUCT_CATEGORIES = new Set(['CEX', 'Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC']);

/**
 * The watchlist's own eligibility rule, applied below the floor: pre-token, and not a wrapped,
 * staked or bridged product of a token that trades, not an exchange front-end, not a versioned pool.
 */
export function isLaunchCandidate(p: SnapshotProtocol): boolean {
  if (!recordsNoToken(p)) return false;
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) return false;
  if (VERSIONED_NAME.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (EXCHANGE_PREFIX.test(p.name)) return false;
  return true;
}

// ---------------------------------------------------------------- the multiples

/** What the snapshot's tokenised protocols say one category's TVL is worth. */
export interface CategoryMultiple {
  category: string;
  peers: number;
  median: number;
  blended: number;
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** The all-market median mcap/TVL and every category's shrunk multiple, from tokenised protocols only. */
export function categoryMultiples(snapshot: Snapshot): { globalMedian: number; byCategory: Map<string, CategoryMultiple> } {
  const ratios = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (recordsNoToken(p) || p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const r = p.mcap_usd / p.tvl_usd;
    all.push(r);
    const key = p.category ?? 'Uncategorised';
    const list = ratios.get(key);
    if (list === undefined) ratios.set(key, [r]);
    else list.push(r);
  }
  const globalMedian = all.length > 0 ? medianOf(all) : 0.2;
  const byCategory = new Map<string, CategoryMultiple>();
  for (const [category, list] of ratios) {
    const median = medianOf(list);
    const blended = clampRatio((list.length * median + SHRINK_PEERS * globalMedian) / (list.length + SHRINK_PEERS));
    byCategory.set(category, { category, peers: list.length, median, blended });
  }
  return { globalMedian, byCategory };
}

function clampRatio(r: number): number {
  return Math.min(RATIO_CAP, Math.max(RATIO_FLOOR, r));
}

/** A category's multiple: its shrunk figure, or the clamped all-market median when no peer trades. */
function multipleFor(category: string | null, multiples: { globalMedian: number; byCategory: Map<string, CategoryMultiple> }): CategoryMultiple {
  const found = multiples.byCategory.get(category ?? 'Uncategorised');
  if (found !== undefined) return found;
  return { category: category ?? 'Uncategorised', peers: 0, median: multiples.globalMedian, blended: clampRatio(multiples.globalMedian) };
}

// ---------------------------------------------------------------- one protocol's value

/** The full arithmetic of one row: every factor the dashboard's detail view shows. */
export interface ValueBreakdown {
  category: string;
  peers: number;
  category_median: number;
  global_median: number;
  multiple: number;
  base_value_usd: number;
  momentum_pct: number;
  momentum_multiplier: number;
  age_days: number | null;
  maturity_multiplier: number;
  chain_count: number;
  reach_multiplier: number;
  implied_value_usd: number;
}

/** Score one protocol under the model. Pure arithmetic on the snapshot's fields. */
export function valueOf(p: SnapshotProtocol, asOf: string, multiples: { globalMedian: number; byCategory: Map<string, CategoryMultiple> }): ValueBreakdown {
  const multiple = multipleFor(p.category, multiples);
  const base = p.tvl_usd * multiple.blended;
  const rawChange = typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : 0;
  const momentumPct = Math.min(MOMENTUM_MAX, Math.max(MOMENTUM_MIN, rawChange));
  const momentumMult = 1 + (momentumPct / 100) * MOMENTUM_WEIGHT;
  const age = ageDays(asOf, p.listed_at);
  const ageForModel = age ?? UNKNOWN_AGE_DAYS;
  const maturityMult = MATURITY_BASE + (Math.min(Math.max(ageForModel, 0), MATURITY_DAYS) / MATURITY_DAYS) * MATURITY_SPAN;
  const chainCount = p.chains.length;
  const reachMult = chainCount <= 1 ? 1 : Math.min(REACH_CAP, 1 + REACH_PER_CHAIN * (chainCount - 1));
  const implied = Math.max(1, Math.round(base * momentumMult * maturityMult * reachMult));
  return {
    category: multiple.category,
    peers: multiple.peers,
    category_median: multiple.median,
    global_median: multiples.globalMedian,
    multiple: multiple.blended,
    base_value_usd: Math.round(base),
    momentum_pct: momentumPct,
    momentum_multiplier: round4(momentumMult),
    age_days: age,
    maturity_multiplier: round4(maturityMult),
    chain_count: chainCount,
    reach_multiplier: round4(reachMult),
    implied_value_usd: implied,
  };
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

// ---------------------------------------------------------------- display figures

/** A whole-dollar figure the way the board prints it: $2.75B, $312M, $45K, $900. */
export function fmtUsd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${Math.round(n)}`;
}

/** A multiple with two decimals, e.g. 0.62x. */
export const fmtMultiple = (n: number): string => `${n.toFixed(2)}x`;

/** A signed percent with one decimal, e.g. +8.3% or -2.2%. */
export const fmtPct = (n: number): string => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;

/** The written case for one row's value, naming the numbers it came from. */
export function rationaleFor(p: SnapshotProtocol, v: ValueBreakdown): string {
  const peerText =
    v.peers > 0
      ? `${v.category} protocols that already trade carry a median market cap of ${fmtMultiple(v.category_median)} of TVL across ${v.peers} tokenised peer${v.peers === 1 ? '' : 's'}; shrunk toward the all-market median of ${fmtMultiple(v.global_median)}, that is a ${fmtMultiple(v.multiple)} multiple`
      : `no ${v.category} protocol in the snapshot trades yet, so the all-market median of ${fmtMultiple(v.global_median)} of TVL is the multiple, at ${fmtMultiple(v.multiple)}`;
  const ageText = v.age_days === null ? 'an unrecorded listing date (modelled as 365 days)' : `${v.age_days} days tracked with no token`;
  const chainText = v.chain_count === 0 ? 'no chain recorded' : `${v.chain_count} chain${v.chain_count === 1 ? '' : 's'}`;
  return (
    `${p.name} holds ${fmtUsd(p.tvl_usd)} of TVL on ${chainText}. ${peerText}, giving a base of ${fmtUsd(v.base_value_usd)}. ` +
    `Seven-day TVL momentum of ${fmtPct(v.momentum_pct)} applies x${v.momentum_multiplier.toFixed(2)}, ${ageText} applies x${v.maturity_multiplier.toFixed(2)}, ` +
    `and its chain reach applies x${v.reach_multiplier.toFixed(2)}: an implied launch value of ${fmtUsd(v.implied_value_usd)}.`
  );
}

// ---------------------------------------------------------------- farm plans

/** The chain a plan starts on: the first the snapshot names, or a neutral phrase. */
function homeChain(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** What one transaction roughly costs on a chain, in words a plan can carry. */
function gasWords(chain: string): string {
  if (chain === 'Ethereum') return 'about $10 of mainnet gas';
  if (chain === 'Solana') return 'well under $1 of fees';
  if (['Base', 'Arbitrum', 'Optimism', 'Polygon', 'zkSync Era', 'Linea', 'Scroll', 'Mantle', 'Blast', 'Mode', 'BSC', 'Avalanche'].includes(chain)) return 'about $1 of gas';
  return 'a few dollars of gas';
}

/** Working capital for one farm position, scaled to the protocol's own size. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 1_000_000_000) return 250;
  if (p.tvl_usd >= 250_000_000) return 150;
  if (p.tvl_usd >= 50_000_000) return 100;
  return 50;
}

/** How long a position should season: younger protocols are held longer to span more snapshots. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

interface PlanFacts {
  name: string;
  chain: string;
  secondChain: string;
  gas: string;
  capital: number;
  half: number;
  hold: number;
  chains: number;
}

function planFacts(p: SnapshotProtocol, age: number | null): PlanFacts {
  const chain = homeChain(p);
  const capital = capitalFor(p);
  return {
    name: p.name,
    chain,
    secondChain: p.chains.length > 1 ? p.chains[1]! : chain,
    gas: gasWords(chain),
    capital,
    half: Math.max(25, Math.round(capital / 2)),
    hold: holdDaysFor(age),
    chains: p.chains.length,
  };
}

const planDex = (f: PlanFacts): string[] => [
  `Swap on ${f.name}: from a fresh farm wallet, trade about $${f.capital} between the two most liquid assets it lists on ${f.chain}, keeping what you receive for the liquidity step. Cost: $${f.capital} of working capital plus ${f.gas}. Time: 15 minutes.`,
  `Add that pair as liquidity in ${f.name}'s highest-TVL pool on ${f.chain} and leave the position alone; prefer the widest-range pool so the position keeps earning instead of drifting out of range. Cost: the same $${f.capital}, now in the pool. Time: 10 minutes.`,
  `Swap $25-$100 through ${f.name} two or three times a week, varying the pair, the size and the time of day, so the wallet's volume reads as ordinary use spread over weeks. Cost: ${f.gas} plus slippage per swap. Time: 5 minutes, a few times a week.`,
  `Hold the liquidity position at least ${f.hold} days, checking the protocol's own points or rewards page weekly and claiming only through links it publishes itself. Cost: the capital stays in the pool and impermanent loss is the real risk. Time: ${f.hold} days.`,
];

const planLending = (f: PlanFacts): string[] => [
  `Supply about $${f.capital} of USDC to ${f.name} on ${f.chain} as collateral and enable borrowing against it. Cost: $${f.capital} of capital plus ${f.gas}. Time: 15 minutes.`,
  `Borrow no more than 40% of the supplied value and re-supply the borrowed asset, looping once at most; keep the health factor above 1.6 at all times so an ordinary price swing cannot liquidate the position. Cost: borrow interest accrues on the loan. Time: 15 minutes.`,
  `Repay and re-borrow small amounts weekly, and take part in any governance vote ${f.name} runs, so the wallet shows continuing use across several weekly snapshots. Cost: ${f.gas} a week. Time: 10 minutes a week.`,
  `Hold the loop at least ${f.hold} days, then unwind in order: repay in full first, withdraw collateral second; never leave the position unwatched over a volatile weekend. Cost: interest over the hold. Time: ${f.hold} days.`,
];

const planCdp = (f: PlanFacts): string[] => [
  `Open a vault in ${f.name} on ${f.chain} and deposit about $${f.capital} of the collateral it accepts (ETH or a liquid staking token). Cost: $${f.capital} of capital plus ${f.gas}. Time: 15 minutes.`,
  `Mint the protocol's stablecoin at a conservative collateral ratio, at least 50% above the liquidation threshold, and put the minted amount to work inside ${f.name}'s own ecosystem (its stability pool or a paired farm) rather than selling it. Cost: the stability fee accrues on what you mint. Time: 10 minutes.`,
  `Top the vault up or repay a slice every week or two so the ratio never drifts toward liquidation, and check the vault after any sharp market move. Cost: ${f.gas} per adjustment. Time: 10 minutes a week.`,
  `Hold the vault at least ${f.hold} days, then repay the minted stablecoin in full before withdrawing any collateral. Cost: stability fees over the hold. Time: ${f.hold} days.`,
];

const planVault = (f: PlanFacts): string[] => [
  `Deposit about $${f.capital} of USDC into the largest vault ${f.name} runs on ${f.chain}; for a curator or allocator, the flagship vault is where a launch would look first for early depositors. Cost: $${f.capital} of capital plus ${f.gas}. Time: 10 minutes.`,
  `Keep the vault shares in the same wallet, untouched. If ${f.name} runs several vaults, open a second, smaller position of about $${f.half} in one more vault instead of moving the first deposit. Cost: $${f.half} more capital plus ${f.gas}. Time: 10 minutes.`,
  `Re-deposit whatever yield the vault pays out, once a month, and read the curator's rebalancing notes: a vault that is actively managed is showing exactly the work a token would govern. Cost: ${f.gas} a month. Time: 10 minutes a month.`,
  `Hold at least ${f.hold} days. Before withdrawing, check the vault's exit liquidity, since curated vaults can hold positions that cannot all leave at once. Cost: the capital stays deployed. Time: ${f.hold} days.`,
];

const planDerivatives = (f: PlanFacts): string[] => [
  `Deposit about $${f.capital} of USDC as margin into ${f.name} on ${f.chain} from a fresh wallet. Cost: $${f.capital} of capital plus ${f.gas}. Time: 15 minutes.`,
  `Open small hedged trades — for example a long and a short on two different markets, kept near delta-neutral — so the account builds genuine trading volume without betting on direction. Cost: the trading fee on each order. Time: 20 minutes.`,
  `Trade a few times a week in modest size and rotate across the markets ${f.name} lists; steady small volume over ${f.hold} days counts for more than one large trade. Cost: fees per trade. Time: 15 minutes, a few times a week.`,
  `Flatten every position before withdrawing margin, and watch the protocol's own announcements for snapshot dates rather than closing early on rumours. Cost: closing fees. Time: ${f.hold} days in all.`,
];

const planRwa = (f: PlanFacts): string[] => [
  `Complete whatever onboarding ${f.name} requires, then mint or buy about $${f.capital} of its yield asset on ${f.chain}. RWA products are jurisdiction-gated: only proceed with an identity that genuinely qualifies. Cost: $${f.capital} of capital plus ${f.gas}. Time: 30 minutes including onboarding.`,
  `Hold the asset in the wallet that minted it; moving tokenised real-world assets between wallets can break the issuer's records and your holding history with it. Cost: nothing beyond the position. Time: none.`,
  `Claim or reinvest each yield payout the asset makes and keep the statements: a launch at an RWA protocol rewards wallets with an unbroken holding record. Cost: ${f.gas} per claim. Time: 10 minutes per payout.`,
  `Hold at least ${f.hold} days — longer suits this category, which rewards patience over churn — and redeem through the protocol's own window rather than a thin secondary market. Cost: any redemption fee in its terms. Time: ${f.hold} days.`,
];

const planBridge = (f: PlanFacts): string[] => [
  `Bridge about $${f.capital} of USDC from ${f.chain} to ${f.secondChain} through ${f.name}'s canonical route, and leave the funds on the destination chain. Cost: $${f.capital} in transit, the bridge's fee plus ${f.gas}. Time: 15 minutes plus the route's settlement time.`,
  `Use the bridged funds once on the far chain — one swap or one deposit in a local app — so the crossing reads as real use rather than a round trip. Cost: gas on ${f.secondChain}. Time: 10 minutes.`,
  `Repeat the crossing weekly in alternating directions and varying amounts, covering as many of ${f.name}'s ${f.chains} recorded chains as fees allow; route diversity is what bridge reward systems count. Cost: the bridge fee on each crossing. Time: 15 minutes a week.`,
  `Keep a small balance parked on each chain ${f.name} serves for at least ${f.hold} days instead of draining everything back to one chain. Cost: capital spread across chains. Time: ${f.hold} days.`,
];

const planStaking = (f: PlanFacts): string[] => [
  `Stake about $${f.capital} of the chain's staking asset through ${f.name} on ${f.chain} from a fresh wallet, and keep the receipt position in that same wallet. Cost: $${f.capital} of capital plus ${f.gas}. Time: 15 minutes.`,
  `Claim and re-stake the rewards the position earns, roughly monthly, so the staked balance compounds and the wallet's history grows. Cost: ${f.gas} per claim. Time: 10 minutes a month.`,
  `If ${f.name} offers more than one validator or pool, split a second $${f.half} across a different one rather than concentrating the whole position. Cost: $${f.half} more capital. Time: 10 minutes.`,
  `Hold the stake at least ${f.hold} days, allowing for the protocol's unbonding period when you finally exit; start the exit only after checking for announced snapshot dates. Cost: the stake is locked while unbonding. Time: ${f.hold} days.`,
];

const planGeneric = (f: PlanFacts): string[] => [
  `Make ${f.name}'s core deposit: put about $${f.capital} of USDC to work on ${f.chain} from a fresh wallet, in the product surface that holds most of its TVL. Cost: $${f.capital} of capital plus ${f.gas}. Time: 15 minutes.`,
  `Repeat one small qualifying action every week — a top-up deposit, a swap, a vote — so the wallet appears in several weekly activity snapshots instead of one. Cost: ${f.gas} a week. Time: 10 minutes a week.`,
  `Open a second surface if ${f.name} offers one (a second pool, a staking position, a governance vote) with about $${f.half}, so the wallet is a user of the protocol and not of one button. Cost: $${f.half} more capital plus ${f.gas}. Time: 10 minutes.`,
  `Hold the main position at least ${f.hold} days and read the protocol's own announcements before withdrawing; claim any reward only from links the protocol itself publishes. Cost: the capital stays deployed. Time: ${f.hold} days.`,
];

/** A protocol's farm plan: four concrete steps for its own category, chains, size and age. */
export function farmPlan(p: SnapshotProtocol, age: number | null): string[] {
  const f = planFacts(p, age);
  const category = (p.category ?? '').toLowerCase();
  if (category === 'dexs' || category.includes('dex')) return planDex(f);
  if (category === 'cdp') return planCdp(f);
  if (category.includes('lend')) return planLending(f);
  if (['risk curators', 'onchain capital allocator', 'yield aggregator', 'yield', 'basis trading', 'liquidity manager', 'collateral management'].includes(category)) return planVault(f);
  if (category.includes('derivative') || category.includes('option') || category.includes('perp')) return planDerivatives(f);
  if (category === 'rwa') return planRwa(f);
  if (category.includes('bridge')) return planBridge(f);
  if (category.includes('staking') || category.includes('stake')) return planStaking(f);
  return planGeneric(f);
}

// ---------------------------------------------------------------- the board

/** One row of board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  score: number;
  model: ValueBreakdown;
  rationale: string;
  farm_steps: string[];
}

/** A board row as data.js carries it: everything the dashboard renders, nothing it does not. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  watchlist: boolean;
  implied_value_usd: number;
  score: number;
  model: ValueBreakdown;
  rationale: string;
  farm_steps: string[];
}

/** A protocol whose token already trades: shown for contrast, never ranked. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  multiple: number | null;
}

/** Everything the dashboard renders. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  scanned_size: number;
  tokenised_size: number;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  global_median: number;
  total_implied_usd: number;
  categories: CategoryMultiple[];
  rows: RadarRow[];
  live: LiveRow[];
}

/** The board: every watchlist protocol, then every launch candidate under the floor, ranked by implied value. */
export function buildBoard(snapshot: Snapshot): BoardRow[] {
  const multiples = categoryMultiples(snapshot);
  const onWatchlist = new Set(snapshot.watchlist);
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = bySlug.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isLaunchCandidate(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1));
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => ({ p, v: valueOf(p, snapshot.as_of, multiples) }));
  scored.sort((a, b) => b.v.implied_value_usd - a.v.implied_value_usd || b.p.tvl_usd - a.p.tvl_usd || (a.p.slug < b.p.slug ? -1 : 1));

  const top = scored.length > 0 ? Math.log(scored[0]!.v.implied_value_usd) : 0;
  const bottom = scored.length > 0 ? Math.log(scored[scored.length - 1]!.v.implied_value_usd) : 0;
  const span = top - bottom;

  return scored.map((s, i) => {
    const score = span > 0 ? Math.round((1000 * (Math.log(s.v.implied_value_usd) - bottom)) / span) / 10 : 100;
    return {
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      mcap_usd: s.p.mcap_usd,
      listed_at: s.p.listed_at,
      gecko_id: s.p.gecko_id,
      symbol: s.p.symbol,
      token_status: 'pre-token' as const,
      watchlist: onWatchlist.has(s.p.slug),
      age_days: s.v.age_days,
      implied_value_usd: s.v.implied_value_usd,
      score,
      model: s.v,
      rationale: rationaleFor(s.p, s.v),
      farm_steps: farmPlan(s.p, s.v.age_days),
    };
  });
}

/** The largest live-token protocols by market cap, with the multiple the market actually gives them. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !recordsNoToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      multiple: p.mcap_usd !== null && p.tvl_usd > 0 ? round4(p.mcap_usd / p.tvl_usd) : null,
    }));
}

/** The board plus everything around it that the dashboard states. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot);
  const live = liveRows(snapshot);
  const multiples = categoryMultiples(snapshot);
  const onBoard = new Set(board.map((r) => r.category ?? 'Uncategorised'));
  const categories = [...multiples.byCategory.values()]
    .filter((c) => onBoard.has(c.category))
    .sort((a, b) => b.peers - a.peers || (a.category < b.category ? -1 : 1));
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    scanned_size: snapshot.protocols.length,
    tokenised_size: snapshot.protocols.filter((p) => !recordsNoToken(p)).length,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !r.watchlist).length,
    live_size: live.length,
    global_median: multiples.globalMedian,
    total_implied_usd: board.reduce((n, r) => n + r.implied_value_usd, 0),
    categories,
    rows: board.map((r) => ({
      rank: r.rank,
      slug: r.slug,
      name: r.name,
      category: r.category,
      chains: r.chains,
      tvl_usd: r.tvl_usd,
      change_7d: r.change_7d,
      listed_at: r.listed_at,
      age_days: r.age_days,
      watchlist: r.watchlist,
      implied_value_usd: r.implied_value_usd,
      score: r.score,
      model: r.model,
      rationale: r.rationale,
      farm_steps: r.farm_steps,
    })),
    live,
  };
  return { board, radar };
}

// ---------------------------------------------------------------- input and gate

/** The snapshot out of a file's text, refused unless it is the shape this model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json carries no as_of date');
  if (typeof o.source !== 'string' || o.source.length === 0) throw new SnapshotError('snapshot.json carries no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json carries no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json carries no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json carries no watchlist of slugs');
  const protocols: SnapshotProtocol[] = o.protocols.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new SnapshotError(`protocol ${i} is not an object`);
    const p = entry as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`protocol ${i} lacks a slug, a name or a TVL`);
    }
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
    return {
      slug: p.slug,
      name: p.name,
      category: str(p.category),
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: num(p.change_7d),
      mcap_usd: num(p.mcap_usd),
      listed_at: str(p.listed_at),
      gecko_id: str(p.gecko_id),
      symbol: str(p.symbol),
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, values, farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  for (const r of board) {
    if (!known.has(r.slug)) return `${r.slug} is not one of the snapshot's protocols`;
    if (seen.has(r.slug)) return `${r.slug} appears twice`;
    seen.add(r.slug);
  }
  const missing = snapshot.watchlist.filter((s) => !seen.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100) return `the board holds ${board.length} rows, under the 100 a board must hold`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is missing or doubled`;
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < byRank.length; i++) {
    if (byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) return `rank ${byRank[i]!.rank} outvalues rank ${byRank[i - 1]!.rank}`;
  }
  if (board.length >= 2 && board.every((r) => r.implied_value_usd === board[0]!.implied_value_usd)) return 'every row carries the same implied value: the board ranks nothing';
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) {
      return `${r.slug} carries implied value ${r.implied_value_usd}`;
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
  }
  return null;
}

/** data.js: the dashboard's dataset as one script assignment, no fetch, no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
