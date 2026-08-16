"use client";

import {
  ArrowRight,
  Bell,
  Check,
  Fingerprint,
  Globe2,
  Keyboard,
  LockKeyhole,
  LogOut,
  ShieldCheck,
  Volume2,
  Wallet as WalletIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useAccount, useConnect, useSignMessage, useWriteContract, usePublicClient } from "wagmi";
import { RiverShell } from "../components/river-shell";
import { activeChainConfig, ERC20_ABI, VAULT_ABI, TOKEN_DECIMALS } from "../../worker/chain-config";

type Preference = "sounds" | "fourColor" | "shortcuts" | "proofNotices";

const preferenceCopy: Record<Preference, { title: string; copy: string; icon: typeof Bell }> = {
  sounds: { title: "Table sounds", copy: "Actions, turn alert, and showdown", icon: Volume2 },
  fourColor: { title: "Four-color deck", copy: "Use a distinct color for every suit", icon: Globe2 },
  shortcuts: { title: "Keyboard actions", copy: "F to fold, C to call, R to raise", icon: Keyboard },
  proofNotices: { title: "Proof notices", copy: "Show receipt status after each hand", icon: Fingerprint },
};

type Account = { id: string; username: string; balance: number };
type LedgerEntry = { id: string; delta: number; reason: string; roomCode: string | null; createdAt: string };
type Stats = { handsPlayed: number; handsWon: number; netResult: number; biggestWin: number; biggestLoss: number };
type OnchainTx = { txHash: string; direction: "deposit" | "withdrawal"; chips: number; status: string; createdAt: string };
type WalletStatus = { wallet: { address: string; verifiedAt: string } | null; transactions: OnchainTx[] };

const EMPTY_STATS: Stats = { handsPlayed: 0, handsWon: 0, netResult: 0, biggestWin: 0, biggestLoss: 0 };

function reasonLabel(reason: string): string {
  if (reason === "signup_bonus") return "Signup bonus";
  if (reason === "buy_in") return "Table buy-in";
  if (reason === "cash_out") return "Table cash-out";
  if (reason === "crypto_deposit") return "Crypto deposit";
  if (reason === "crypto_withdraw") return "Crypto withdrawal";
  if (reason === "crypto_withdraw_failed_refund") return "Withdrawal refund";
  return reason;
}

function shortHex(value: string): string {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function chipsToTokenBaseUnits(chips: number): bigint {
  return BigInt(chips) * 10n ** BigInt(TOKEN_DECIMALS);
}

export default function AccountPage() {
  const [saved, setSaved] = useState(false);
  const [preferences, setPreferences] = useState<Record<Preference, boolean>>({ sounds: true, fourColor: false, shortcuts: true, proofNotices: true });

  const [account, setAccount] = useState<Account | null | "loading">("loading");
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [stats, setStats] = useState<Stats>(EMPTY_STATS);
  const [authMode, setAuthMode] = useState<"login" | "signup">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);

  const { address, isConnected } = useAccount();
  const { connectAsync, connectors } = useConnect();
  const { signMessageAsync } = useSignMessage();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();
  const [walletStatus, setWalletStatus] = useState<WalletStatus | null>(null);
  const [walletBusy, setWalletBusy] = useState(false);
  const [walletError, setWalletError] = useState("");
  const [depositChips, setDepositChips] = useState("");
  const [withdrawChips, setWithdrawChips] = useState("");
  const [withdrawResult, setWithdrawResult] = useState<{ txHash: string; fee: number; netChips: number } | null>(null);
  const isLinked = Boolean(address && walletStatus?.wallet && walletStatus.wallet.address.toLowerCase() === address.toLowerCase());

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const stored = window.localStorage.getItem("river-preferences");
      if (stored) {
        try { setPreferences(JSON.parse(stored)); } catch { /* keep defaults */ }
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  async function loadAccount() {
    const response = await fetch("/api/auth/me");
    const body = (await response.json()) as { user: Account | null };
    setAccount(body.user);
    if (body.user) {
      const [ledgerResponse, statsResponse, walletResponse] = await Promise.all([
        fetch("/api/account/ledger"),
        fetch("/api/account/stats"),
        fetch("/api/wallet/status"),
      ]);
      if (ledgerResponse.ok) {
        const ledgerBody = (await ledgerResponse.json()) as { entries: LedgerEntry[] };
        setLedger(ledgerBody.entries);
      }
      if (statsResponse.ok) {
        const statsBody = (await statsResponse.json()) as { stats: Stats };
        setStats(statsBody.stats);
      }
      if (walletResponse.ok) {
        setWalletStatus((await walletResponse.json()) as WalletStatus);
      }
    } else {
      setLedger([]);
      setStats(EMPTY_STATS);
      setWalletStatus(null);
    }
  }

  async function handleConnectWallet() {
    const connector = connectors[0];
    if (!connector) {
      setWalletError("No wallet extension found in this browser.");
      return;
    }
    setWalletError("");
    try {
      await connectAsync({ connector });
    } catch (error) {
      setWalletError(error instanceof Error ? error.message : "Could not connect.");
    }
  }

  async function handleLinkWallet() {
    if (!address) return;
    setWalletBusy(true);
    setWalletError("");
    try {
      const challengeResponse = await fetch("/api/wallet/challenge");
      const challengeBody = (await challengeResponse.json()) as { message?: string; error?: string };
      if (!challengeResponse.ok || !challengeBody.message) throw new Error(challengeBody.error ?? "Could not start linking.");

      const signature = await signMessageAsync({ message: challengeBody.message });

      const linkResponse = await fetch("/api/wallet/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, message: challengeBody.message, signature }),
      });
      const linkBody = (await linkResponse.json()) as { error?: string };
      if (!linkResponse.ok) throw new Error(linkBody.error ?? "Linking failed.");

      await loadAccount();
    } catch (error) {
      setWalletError(error instanceof Error ? error.message : "Linking failed.");
    } finally {
      setWalletBusy(false);
    }
  }

  async function handleDeposit() {
    const chips = Math.trunc(Number(depositChips));
    if (!address || !publicClient || !Number.isFinite(chips) || chips <= 0) return;
    setWalletBusy(true);
    setWalletError("");
    try {
      const amount = chipsToTokenBaseUnits(chips);
      const allowance = (await publicClient.readContract({
        address: activeChainConfig.tokenAddress,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [address, activeChainConfig.escrowAddress],
      })) as bigint;

      if (allowance < amount) {
        const approveHash = await writeContractAsync({
          address: activeChainConfig.tokenAddress,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [activeChainConfig.escrowAddress, amount],
        });
        await publicClient.waitForTransactionReceipt({ hash: approveHash });
      }

      const depositHash = await writeContractAsync({
        address: activeChainConfig.escrowAddress,
        abi: VAULT_ABI,
        functionName: "deposit",
        args: [amount],
      });
      await publicClient.waitForTransactionReceipt({ hash: depositHash });

      const confirmResponse = await fetch("/api/wallet/deposit-confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ txHash: depositHash }),
      });
      const confirmBody = (await confirmResponse.json()) as { error?: string };
      if (!confirmResponse.ok) throw new Error(confirmBody.error ?? "Deposit could not be confirmed.");

      setDepositChips("");
      await loadAccount();
    } catch (error) {
      setWalletError(error instanceof Error ? error.message : "Deposit failed.");
    } finally {
      setWalletBusy(false);
    }
  }

  async function handleWithdraw() {
    const chips = Math.trunc(Number(withdrawChips));
    if (!Number.isFinite(chips) || chips <= 0) return;
    setWalletBusy(true);
    setWalletError("");
    setWithdrawResult(null);
    try {
      const response = await fetch("/api/wallet/withdraw-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chips }),
      });
      const body = (await response.json()) as { txHash?: string; fee?: number; netChips?: number; error?: string };
      if (!response.ok || !body.txHash) throw new Error(body.error ?? "Withdrawal failed.");

      setWithdrawResult({ txHash: body.txHash, fee: body.fee ?? 0, netChips: body.netChips ?? 0 });
      setWithdrawChips("");
      await loadAccount();
    } catch (error) {
      setWalletError(error instanceof Error ? error.message : "Withdrawal failed.");
    } finally {
      setWalletBusy(false);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time client-only bootstrap: read the session cookie via /api/auth/me, which isn't available at SSR time
    loadAccount();
  }, []);

  async function submitAuth(event: React.FormEvent) {
    event.preventDefault();
    setAuthBusy(true);
    setAuthError("");
    try {
      const response = await fetch(`/api/auth/${authMode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const body = (await response.json()) as { user?: Account; error?: string };
      if (!response.ok || !body.user) {
        setAuthError(body.error ?? "Something went wrong.");
        return;
      }
      setAccount(body.user);
      setPassword("");
      await loadAccount();
    } catch {
      setAuthError("Couldn't reach the server. Try again.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    setAccount(null);
    setLedger([]);
  }

  function toggle(key: Preference) {
    setPreferences((current) => ({ ...current, [key]: !current[key] }));
  }

  function save() {
    window.localStorage.setItem("river-preferences", JSON.stringify(preferences));
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2200);
  }

  const isLoggedIn = account !== null && account !== "loading";

  return (
    <RiverShell active="account" dark footer={false}>
      <main className="account-page">
        <section className="account-hero">
          <div className="account-avatar">{isLoggedIn ? account.username.slice(0, 1).toUpperCase() : "?"}</div>
          <div>
            <span>{isLoggedIn ? "ACCOUNT" : "NOT SIGNED IN"}</span>
            <h1>{isLoggedIn ? account.username : "Sign in to RIVER"}</h1>
            <p>{isLoggedIn ? "Real account - your test-chip balance persists across sessions and tables." : "Create an account to keep a test-chip bankroll between sessions instead of starting over at every table."}</p>
          </div>
          <div className="account-status"><i /><span>{isLoggedIn ? "BALANCE" : "STATUS"}</span><b>{isLoggedIn ? `${account.balance} TEST` : "GUEST"}</b></div>
        </section>

        <div className="account-layout">
          <section className="account-main">
            {isLoggedIn ? (
              <>
                <header><div><span>BANKROLL</span><h2>Your test-chip balance.</h2></div></header>
                <section className="account-proof-summary">
                  <div><Fingerprint size={21} /><span>YOUR STATS</span></div>
                  <div className="proof-summary-metrics">
                    <article><span>HANDS PLAYED</span><b>{stats.handsPlayed}</b><small>real hands</small></article>
                    <article><span>WIN RATE</span><b>{stats.handsPlayed > 0 ? Math.round((stats.handsWon / stats.handsPlayed) * 100) : 0}%</b><small>{stats.handsWon} won</small></article>
                    <article><span>NET RESULT</span><b className={stats.netResult >= 0 ? "positive" : ""}>{stats.netResult >= 0 ? "+" : ""}{stats.netResult}</b><small>test chips</small></article>
                    <article><span>BIGGEST WIN</span><b className="positive">+{stats.biggestWin}</b><small>worst {stats.biggestLoss}</small></article>
                  </div>
                </section>
                <section className="account-proof-summary">
                  <div><Fingerprint size={21} /><span>RECENT ACTIVITY</span></div>
                  <div className="ledger-list">
                    {ledger.length === 0 ? (
                      <p className="ledger-empty">No activity yet - sit at a table to buy in.</p>
                    ) : (
                      ledger.map((entry) => (
                        <div className="ledger-row" key={entry.id}>
                          <span>{reasonLabel(entry.reason)}{entry.roomCode ? ` · ${entry.roomCode}` : ""}</span>
                          <b className={entry.delta >= 0 ? "positive" : "negative"}>{entry.delta >= 0 ? "+" : ""}{entry.delta}</b>
                        </div>
                      ))
                    )}
                  </div>
                </section>
                <section className="account-proof-summary">
                  <div><WalletIcon size={21} /><span>CRYPTO WALLET</span></div>
                  <div className="ledger-list">
                    {!isConnected ? (
                      <>
                        <p className="ledger-empty">Connect a wallet to deposit or withdraw {activeChainConfig.chainId === 8453 ? "USDC" : "test USDC"} on {activeChainConfig.chainId === 8453 ? "Base" : "the local test chain"}.</p>
                        <button type="button" className="save-preferences" onClick={handleConnectWallet}>Connect wallet</button>
                      </>
                    ) : !isLinked ? (
                      <>
                        <p className="ledger-empty">Connected: {shortHex(address ?? "")}. Sign a message to link this wallet to your account - no funds move yet.</p>
                        <button type="button" className="save-preferences" onClick={handleLinkWallet} disabled={walletBusy}>{walletBusy ? "Working..." : "Link wallet"}</button>
                      </>
                    ) : (
                      <>
                        <p className="ledger-empty">Linked: {shortHex(address ?? "")}. Escrow contract: {shortHex(activeChainConfig.escrowAddress)}.</p>
                        <div className="account-form-grid">
                          <label>
                            Deposit (chips)
                            <input value={depositChips} onChange={(event) => setDepositChips(event.target.value)} inputMode="numeric" placeholder="e.g. 500" />
                          </label>
                          <label className="wide">
                            <button type="button" onClick={handleDeposit} disabled={walletBusy}>{walletBusy ? "Working..." : "Deposit"}</button>
                          </label>
                          <label>
                            Withdraw (chips)
                            <input value={withdrawChips} onChange={(event) => setWithdrawChips(event.target.value)} inputMode="numeric" placeholder="e.g. 200" />
                          </label>
                          <label className="wide">
                            <button type="button" onClick={handleWithdraw} disabled={walletBusy}>{walletBusy ? "Working..." : "Withdraw"}</button>
                          </label>
                        </div>
                        {withdrawResult && (
                          <p className="ledger-empty">
                            Sent {withdrawResult.netChips} chips after a {withdrawResult.fee}-chip network fee - tx {shortHex(withdrawResult.txHash)}
                          </p>
                        )}
                      </>
                    )}
                    {walletError && <p className="wide auth-error">{walletError}</p>}
                    {walletStatus?.transactions.map((tx) => (
                      <div className="ledger-row" key={tx.txHash}>
                        <span>{tx.direction === "deposit" ? "Deposit" : "Withdrawal"} · {shortHex(tx.txHash)}</span>
                        <b className={tx.direction === "deposit" ? "positive" : "negative"}>{tx.direction === "deposit" ? "+" : "-"}{tx.chips}</b>
                      </div>
                    ))}
                  </div>
                </section>
              </>
            ) : (
              <>
                <header><div><span>{authMode === "login" ? "SIGN IN" : "CREATE ACCOUNT"}</span><h2>{authMode === "login" ? "Welcome back." : "Start with 1000 test chips."}</h2></div></header>
                <form className="account-form-grid" onSubmit={submitAuth}>
                  <label>Username<input value={username} onChange={(event) => setUsername(event.target.value)} maxLength={20} autoComplete="username" required /></label>
                  <label>Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={8} autoComplete={authMode === "login" ? "current-password" : "new-password"} required /></label>
                  <label className="wide">
                    <button type="submit" disabled={authBusy}>{authBusy ? "Working..." : authMode === "login" ? "Sign in" : "Create account"}</button>
                  </label>
                  {authError && <p className="wide auth-error">{authError}</p>}
                </form>
                <p className="auth-toggle">
                  {authMode === "login" ? "Need an account? " : "Already have one? "}
                  <button type="button" onClick={() => { setAuthMode(authMode === "login" ? "signup" : "login"); setAuthError(""); }}>
                    {authMode === "login" ? "Create one" : "Sign in"}
                  </button>
                </p>
              </>
            )}

            <div className="preferences-head"><div><span>TABLE PREFERENCES</span><h2>Keep the controls familiar.</h2></div><p>Saved only on this browser.</p></div>
            <div className="preference-list">{(Object.keys(preferenceCopy) as Preference[]).map((key) => { const item = preferenceCopy[key]; const Icon = item.icon; return <button className={preferences[key] ? "enabled" : ""} onClick={() => toggle(key)} key={key}><Icon size={18} /><span><b>{item.title}</b><small>{item.copy}</small></span><i><span /></i></button>; })}</div>
            <button onClick={save} className="save-preferences">{saved ? <Check size={15} /> : null}{saved ? "Saved" : "Save preferences"}</button>
          </section>

          <aside className="account-rail">
            {isLoggedIn && (
              <section><div className="account-rail-head"><LockKeyhole size={17} /><span>SESSION</span></div><h2>Signed in as {account.username}.</h2><p>One active session, authenticated by a password + a signed session cookie.</p><button className="save-preferences" onClick={signOut}><LogOut size={14} /> Sign out</button></section>
            )}
            <section className="account-scope-card"><ShieldCheck size={20} /><span>HONEST SCOPE</span><h3>Real account, real persistent balance - still test chips.</h3><p>Passwords are hashed (PBKDF2), sessions are signed cookies, and the balance is a real D1-backed ledger. The crypto wallet below moves real test-network tokens through a real, tested escrow contract - it isn&apos;t deployed anywhere real value could reach yet.</p><a href="/fairness">Read the fairness model <ArrowRight size={14} /></a></section>
          </aside>
        </div>
      </main>
    </RiverShell>
  );
}
