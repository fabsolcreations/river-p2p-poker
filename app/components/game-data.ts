export type GameFormat = "NL Hold'em" | "Pot-Limit Omaha" | "Short Deck" | "Mixed";
export type GameKind = "Cash" | "Sit & Go" | "Tournament";

export type RiverGame = {
  id: string;
  name: string;
  host: string;
  format: GameFormat;
  kind: GameKind;
  stakes: string;
  buyIn: string;
  seated: number;
  seats: number;
  avgPot: string;
  speed: "Slow" | "Standard" | "Turbo";
  access: "Open" | "Club" | "Invite";
  accent: "mint" | "blue" | "coral" | "violet" | "amber";
  tableCount: number | "Auto";
  roomCapacity: string;
};

export const riverGames: RiverGame[] = [
  {
    id: "after-hours",
    name: "After Hours",
    host: "Night River",
    format: "NL Hold'em",
    kind: "Cash",
    stakes: "$0.25 / $0.50",
    buyIn: "20-100 USDC",
    seated: 5,
    seats: 6,
    avgPot: "11.40",
    speed: "Standard",
    access: "Open",
    accent: "mint",
    tableCount: "Auto",
    roomCapacity: "Open-ended",
  },
  {
    id: "blackbird",
    name: "Blackbird PLO",
    host: "Double Suited",
    format: "Pot-Limit Omaha",
    kind: "Cash",
    stakes: "$1 / $2",
    buyIn: "80-400 USDC",
    seated: 4,
    seats: 6,
    avgPot: "73.10",
    speed: "Standard",
    access: "Club",
    accent: "coral",
    tableCount: 4,
    roomCapacity: "24 players",
  },
  {
    id: "two-street",
    name: "Two Street",
    host: "Signal Club",
    format: "Short Deck",
    kind: "Cash",
    stakes: "$0.50 / $1",
    buyIn: "50-200 USDC",
    seated: 3,
    seats: 6,
    avgPot: "28.75",
    speed: "Turbo",
    access: "Open",
    accent: "blue",
    tableCount: 2,
    roomCapacity: "12 players",
  },
  {
    id: "the-booth",
    name: "The Booth",
    host: "Heads Up Only",
    format: "NL Hold'em",
    kind: "Sit & Go",
    stakes: "$50 match",
    buyIn: "50 USDC",
    seated: 1,
    seats: 2,
    avgPot: "Match",
    speed: "Turbo",
    access: "Open",
    accent: "violet",
    tableCount: 1,
    roomCapacity: "2 players",
  },
  {
    id: "sunday-signal",
    name: "Sunday Signal",
    host: "RIVER Open",
    format: "NL Hold'em",
    kind: "Tournament",
    stakes: "$20 entry",
    buyIn: "20 USDC",
    seated: 48,
    seats: 72,
    avgPot: "2K GTD",
    speed: "Standard",
    access: "Open",
    accent: "amber",
    tableCount: 8,
    roomCapacity: "72 players",
  },
  {
    id: "dealers-choice",
    name: "Dealer's Choice",
    host: "The Workshop",
    format: "Mixed",
    kind: "Cash",
    stakes: "$0.50 / $1",
    buyIn: "40-200 USDC",
    seated: 5,
    seats: 8,
    avgPot: "35.20",
    speed: "Slow",
    access: "Invite",
    accent: "mint",
    tableCount: "Auto",
    roomCapacity: "Open-ended",
  },
];

export const productModes = [
  { name: "No-Limit Hold'em", state: "Proof engine live", code: "NLH" },
  { name: "Pot-Limit Omaha", state: "Interface modeled", code: "PLO" },
  { name: "Short Deck", state: "Rules specified", code: "6+" },
  { name: "Sit & Go", state: "Lobby modeled", code: "SNG" },
  { name: "Multi-table tournaments", state: "Architecture next", code: "MTT" },
];

export type TournamentEvent = {
  id: string;
  name: string;
  series: string;
  format: "NL Hold'em" | "Pot-Limit Omaha" | "Short Deck";
  entry: string;
  guarantee: string;
  starts: string;
  day: string;
  date: string;
  registered: number;
  capacity: number;
  speed: "Standard" | "Turbo" | "Deep";
  access: "Open" | "Club" | "Satellite";
  status: "Registering" | "Late registration" | "Scheduled";
  featured?: boolean;
};

export const tournamentEvents: TournamentEvent[] = [
  { id: "signal-main", name: "Sunday Signal", series: "RIVER OPEN 01", format: "NL Hold'em", entry: "20 USDC", guarantee: "2,000 USDC", starts: "7:00 PM CT", day: "SUN", date: "16 AUG", registered: 48, capacity: 72, speed: "Standard", access: "Open", status: "Registering", featured: true },
  { id: "night-cap", name: "Night Cap Turbo", series: "DAILY", format: "NL Hold'em", entry: "5 USDC", guarantee: "250 USDC", starts: "11:30 PM CT", day: "WED", date: "12 AUG", registered: 31, capacity: 54, speed: "Turbo", access: "Open", status: "Late registration" },
  { id: "blackbird-plo", name: "Blackbird Six-Max", series: "NIGHT RIVER", format: "Pot-Limit Omaha", entry: "50 USDC", guarantee: "5,000 USDC", starts: "8:30 PM CT", day: "FRI", date: "14 AUG", registered: 22, capacity: 36, speed: "Deep", access: "Club", status: "Registering" },
  { id: "signal-sat", name: "Signal Seat Sprint", series: "SATELLITE", format: "NL Hold'em", entry: "2 USDC", guarantee: "5 seats", starts: "5:30 PM CT", day: "SUN", date: "16 AUG", registered: 17, capacity: 45, speed: "Turbo", access: "Satellite", status: "Scheduled" },
  { id: "six-plus", name: "Six Plus Trial", series: "FORMAT LAB", format: "Short Deck", entry: "10 USDC", guarantee: "500 USDC", starts: "9:00 PM CT", day: "SAT", date: "15 AUG", registered: 18, capacity: 36, speed: "Standard", access: "Open", status: "Scheduled" },
];
