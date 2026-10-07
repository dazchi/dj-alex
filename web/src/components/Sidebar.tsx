import { useEffect, useState } from 'react';
import { Disc3, History, Link2, Loader2, LogOut, Music2, RefreshCw, Volume2, Wifi, WifiOff } from 'lucide-react';
import { act, logout } from '../lib/socket';
import { navigate, set, useStore, type View } from '../lib/store';
import { api, cn } from '../lib/util';
import { Avatar, Button } from './ui';

const NAV: { view: View; label: string; icon: typeof Music2 }[] = [
  { view: 'songs', label: 'Songs', icon: Music2 },
  { view: 'albums', label: 'Albums', icon: Disc3 },
  { view: 'history', label: 'Recently played', icon: History },
];

export function Sidebar() {
  const view = useStore((s) => s.view);
  const library = useStore((s) => s.library);

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
      <Logo />

      <nav className="flex flex-col gap-1">
        {NAV.map(({ view: v, label, icon: Icon }) => (
          <button
            key={v}
            type="button"
            onClick={() => navigate(v)}
            className={cn(
              'focus-ring flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition',
              view === v ? 'bg-white/10 text-white' : 'text-zinc-400 hover:bg-white/5 hover:text-white',
            )}
          >
            <Icon size={18} className={view === v ? 'text-accent' : ''} />
            {label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => set({ urlDialogOpen: true, drawerOpen: false })}
          className="focus-ring flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-zinc-400 transition hover:bg-white/5 hover:text-white"
        >
          <Link2 size={18} />
          Add from URL
        </button>
      </nav>

      <VoicePanel />

      <div className="mt-auto flex flex-col gap-4">
        <OnlinePanel />
        {library && (
          <div className="flex items-center justify-between px-1 text-xs text-zinc-500">
            <span>{library.tracks.toLocaleString()} tracks in library</span>
            <button
              type="button"
              title="Rescan music folder"
              className="rounded-full p-1 hover:bg-white/10 hover:text-white"
              onClick={() => api.rescan()}
            >
              <RefreshCw size={13} className={library.scanning ? 'animate-spin' : ''} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function Logo() {
  return (
    <div className="flex items-center gap-3 px-1">
      <div className="grid size-10 place-items-center rounded-xl bg-brand shadow-lg shadow-fuchsia-900/40">
        <Disc3 size={22} className="text-white" />
      </div>
      <div>
        <div className="text-lg font-bold leading-tight tracking-tight">DJ Alex</div>
        <ConnectionBadge />
      </div>
    </div>
  );
}

function ConnectionBadge() {
  const connected = useStore((s) => s.connected);
  const guild = useStore((s) => s.player?.voice.guildName);
  return (
    <div className={cn('flex items-center gap-1 text-[11px]', connected ? 'text-zinc-500' : 'text-red-400')}>
      {connected ? <Wifi size={11} /> : <WifiOff size={11} />}
      {connected ? (guild ?? 'Connected') : 'Reconnecting…'}
    </div>
  );
}

function VoicePanel() {
  const voice = useStore((s) => s.player?.voice);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!voice) return;
    if (voice.channelId) setSelected(voice.channelId);
    else if (!selected || !voice.channels.some((c) => c.id === selected)) {
      const busiest = [...voice.channels].sort((a, b) => b.memberCount - a.memberCount)[0];
      setSelected(busiest?.id ?? '');
    }
  }, [voice?.channelId, voice?.channels]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!voice) return null;

  const join = async () => {
    if (!selected) return;
    setBusy(true);
    await act('voice:join', { channelId: selected });
    setBusy(false);
  };

  return (
    <section className="glass rounded-2xl p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Voice</span>
        <span
          className={cn(
            'flex items-center gap-1.5 text-[11px] font-medium',
            !voice.botReady ? 'text-red-400' : voice.connected ? 'text-emerald-400' : voice.connecting ? 'text-amber-300' : 'text-zinc-400',
          )}
        >
          <span
            className={cn(
              'size-1.5 rounded-full',
              !voice.botReady ? 'bg-red-400' : voice.connected ? 'bg-emerald-400' : voice.connecting ? 'animate-pulse bg-amber-300' : 'bg-zinc-500',
            )}
          />
          {!voice.botReady ? 'Bot offline' : voice.connected ? 'Connected' : voice.connecting ? 'Connecting' : 'Not connected'}
        </span>
      </div>

      {!voice.botReady ? (
        <p className="text-xs leading-relaxed text-zinc-500">The Discord bot isn’t running. Check DISCORD_TOKEN in the server’s .env file.</p>
      ) : (
        <>
          {voice.connected && voice.channelName && (
            <div className="mb-3 flex items-center gap-2 text-sm">
              <Volume2 size={16} className="shrink-0 text-emerald-400" />
              <span className="truncate font-medium">{voice.channelName}</span>
            </div>
          )}
          {voice.connected && (
            <div className="mb-3 flex flex-wrap items-center gap-1.5">
              {voice.listeners.length === 0 ? (
                <span className="text-xs text-zinc-500">Nobody is listening yet</span>
              ) : (
                voice.listeners.map((m) => <Avatar key={m.id} name={m.name} src={m.avatar} className="size-7 ring-2 ring-ink-900" />)
              )}
            </div>
          )}
          <div className="flex gap-2">
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              className="focus-ring h-9 min-w-0 flex-1 rounded-full border border-white/8 bg-white/5 px-3 text-sm text-zinc-200 outline-none"
              aria-label="Voice channel"
            >
              {voice.channels.length === 0 && <option value="">No voice channels</option>}
              {voice.channels.map((c) => (
                <option key={c.id} value={c.id} className="bg-ink-800">
                  🔊 {c.name}
                  {c.memberCount ? ` (${c.memberCount})` : ''}
                </option>
              ))}
            </select>
            {voice.connected && selected === voice.channelId ? (
              <Button variant="danger" className="h-9 px-3" onClick={() => act('voice:leave')} title="Disconnect">
                <LogOut size={15} />
              </Button>
            ) : (
              <Button variant="primary" className="h-9 px-4" disabled={!selected || busy} onClick={join}>
                {busy ? <Loader2 size={15} className="animate-spin" /> : voice.connected ? 'Move' : 'Join'}
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function OnlinePanel() {
  const presence = useStore((s) => s.presence);
  const me = useStore((s) => s.me);
  return (
    <section className="glass rounded-2xl p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">Online · {presence.length}</div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {presence.map((u) => (
          <Avatar key={u.id ?? u.name} name={u.name} src={u.avatar} className="size-7 ring-2 ring-ink-900" />
        ))}
      </div>
      {me && (
        <div className="flex items-center gap-2 border-t border-white/5 pt-3">
          <Avatar name={me.name} src={me.avatar} className="size-8" />
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-sm font-medium text-zinc-100">{me.name}</div>
            <div className="truncate text-xs text-zinc-500">@{me.username}</div>
          </div>
          <button
            type="button"
            title="Log out"
            aria-label="Log out"
            onClick={() => logout()}
            className="focus-ring rounded-full p-2 text-zinc-500 transition hover:bg-white/10 hover:text-white"
          >
            <LogOut size={15} />
          </button>
        </div>
      )}
    </section>
  );
}
