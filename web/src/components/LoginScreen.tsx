import { useEffect, useState } from 'react';
import { AlertCircle, Disc3, Loader2 } from 'lucide-react';
import { login } from '../lib/socket';
import { useStore } from '../lib/store';

function DiscordLogo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 127.14 96.36" fill="currentColor" aria-hidden>
      <path d="M107.7 8.07A105.15 105.15 0 0 0 81.47 0a72.06 72.06 0 0 0-3.36 6.83 97.68 97.68 0 0 0-29.11 0A72.37 72.37 0 0 0 45.64 0a105.89 105.89 0 0 0-26.25 8.09C2.79 32.65-1.71 56.6.54 80.21a105.73 105.73 0 0 0 32.17 16.15 77.7 77.7 0 0 0 6.89-11.11 68.42 68.42 0 0 1-10.85-5.18c.91-.66 1.8-1.34 2.66-2a75.57 75.57 0 0 0 64.32 0c.87.71 1.76 1.39 2.66 2a68.68 68.68 0 0 1-10.87 5.19 77 77 0 0 0 6.89 11.1 105.25 105.25 0 0 0 32.19-16.14c2.64-27.38-4.51-51.11-18.9-72.15ZM42.45 65.69C36.18 65.69 31 60 31 53s5-12.74 11.43-12.74S54 46 53.89 53s-5.05 12.69-11.44 12.69Zm42.24 0C78.41 65.69 73.25 60 73.25 53s5-12.74 11.44-12.74S96.23 46 96.12 53s-5.04 12.69-11.43 12.69Z" />
    </svg>
  );
}

export function LoginScreen() {
  const loginConfigured = useStore((s) => s.loginConfigured);
  const [error, setError] = useState<string | null>(null);
  const [redirecting, setRedirecting] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const err = params.get('authError');
    if (err) {
      setError(err);
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, []);

  return (
    <div className="relative grid h-dvh place-items-center overflow-hidden px-4">
      <div className="pointer-events-none absolute -left-32 -top-32 size-[34rem] rounded-full bg-violet-600/25 blur-[120px]" />
      <div className="pointer-events-none absolute -bottom-40 -right-20 size-[30rem] rounded-full bg-fuchsia-600/20 blur-[120px]" />

      <div className="relative w-full max-w-sm animate-pop rounded-3xl border border-white/10 bg-ink-850/80 p-8 text-center shadow-2xl shadow-black/60 backdrop-blur-xl">
        <div className="mx-auto grid size-16 place-items-center rounded-2xl bg-brand shadow-lg shadow-fuchsia-900/40">
          <Disc3 size={34} className="text-white" />
        </div>
        <h1 className="mt-5 text-2xl font-bold tracking-tight">DJ Alex</h1>
        <p className="mt-2 text-sm text-zinc-400">Queue music for your Discord voice channel together. Log in with the Discord account you use on the server.</p>

        {error && (
          <div className="mt-5 flex items-start gap-2 rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-left text-sm text-red-200">
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {!loginConfigured && !error && (
          <div className="mt-5 rounded-xl border border-amber-500/20 bg-amber-500/10 p-3 text-left text-sm text-amber-200">
            Discord login isn’t configured yet. Set <code className="text-amber-100">DISCORD_CLIENT_SECRET</code> in the server’s .env file.
          </div>
        )}

        <button
          type="button"
          disabled={redirecting}
          onClick={() => {
            setRedirecting(true);
            login();
          }}
          className="focus-ring mt-6 flex h-12 w-full items-center justify-center gap-3 rounded-full bg-[#5865F2] font-semibold text-white shadow-lg shadow-indigo-900/40 transition hover:bg-[#4752c4] active:scale-[0.98] disabled:opacity-70"
        >
          {redirecting ? <Loader2 size={20} className="animate-spin" /> : <DiscordLogo />}
          Log in with Discord
        </button>
        <p className="mt-4 text-xs text-zinc-500">We only read your username and avatar.</p>
      </div>
    </div>
  );
}
