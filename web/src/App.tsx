import { useEffect, useState, type ReactNode } from 'react';
import { Activity, Library, ListMusic, Loader2, Menu } from 'lucide-react';
import { Toaster } from 'sonner';
import { act, checkAuth } from './lib/socket';
import { set, useStore, type MobileTab } from './lib/store';
import { cn } from './lib/util';
import { Sidebar, Logo } from './components/Sidebar';
import { SongsView } from './components/SongsView';
import { AlbumsView } from './components/AlbumsView';
import { HistoryView } from './components/HistoryView';
import { QueuePanel } from './components/QueuePanel';
import { ActivityFeed } from './components/ActivityFeed';
import { MobileControls, PlayerBar } from './components/PlayerBar';
import { AddUrlDialog } from './components/Dialogs';
import { LoginScreen } from './components/LoginScreen';

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [role="dialog"]')) return;
      if (e.key === 'MediaPlayPause' || (e.code === 'Space' && !t.closest('button, [role="slider"]'))) {
        e.preventDefault();
        void act('player:toggle');
      } else if (e.key === 'MediaTrackNext' || (e.shiftKey && e.key === 'N')) void act('player:next');
      else if (e.key === 'MediaTrackPrevious' || (e.shiftKey && e.key === 'P')) void act('player:prev');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

function useDocumentTitle() {
  const current = useStore((s) => s.player?.current?.track);
  const playing = useStore((s) => s.player?.status === 'playing');
  useEffect(() => {
    document.title = current ? `${playing ? '▶ ' : ''}${current.title} · ${current.artist}` : 'DJ Alex';
  }, [current, playing]);
}

/** Soft blurred artwork glow behind the whole UI. */
function Ambient() {
  const track = useStore((s) => s.player?.current?.track);
  return (
    <div className="pointer-events-none fixed inset-0 -z-0 overflow-hidden" aria-hidden>
      <div className="absolute -left-40 -top-40 size-[36rem] rounded-full bg-violet-600/15 blur-[120px]" />
      <div className="absolute -bottom-48 right-0 size-[32rem] rounded-full bg-fuchsia-600/10 blur-[120px]" />
      {track?.hasCover && (
        <img
          key={track.id}
          src={`/api/cover/${track.id}`}
          alt=""
          className="absolute left-1/2 top-0 h-[60vh] w-[120vw] -translate-x-1/2 animate-fade-in object-cover opacity-[0.12] blur-[100px]"
        />
      )}
    </div>
  );
}

function MainView() {
  const view = useStore((s) => s.view);
  if (view === 'albums') return <AlbumsView />;
  if (view === 'history') return <HistoryView />;
  return <SongsView />;
}

function SidePanel() {
  const panel = useStore((s) => s.sidePanel);
  const queueLen = useStore((s) => s.player?.queue.length ?? 0);
  return (
    <aside className="relative hidden w-[340px] shrink-0 flex-col border-l border-white/5 bg-ink-900/50 backdrop-blur-xl lg:flex xl:w-[380px]">
      <div className="flex gap-1 p-3">
        <Tab active={panel === 'queue'} onClick={() => set({ sidePanel: 'queue' })}>
          <ListMusic size={16} /> Queue
          {queueLen > 0 && <span className="rounded-full bg-white/10 px-1.5 text-[11px] tabular-nums">{queueLen}</span>}
        </Tab>
        <Tab active={panel === 'activity'} onClick={() => set({ sidePanel: 'activity' })}>
          <Activity size={16} /> Activity
        </Tab>
      </div>
      {panel === 'queue' ? (
        <QueuePanel />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ActivityFeed />
        </div>
      )}
    </aside>
  );
}

function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'focus-ring flex flex-1 items-center justify-center gap-2 rounded-xl py-2 text-sm font-medium transition',
        active ? 'bg-white/10 text-white' : 'text-zinc-400 hover:bg-white/5 hover:text-white',
      )}
    >
      {children}
    </button>
  );
}

const MOBILE_TABS: { tab: MobileTab; label: string; icon: typeof Library }[] = [
  { tab: 'library', label: 'Library', icon: Library },
  { tab: 'queue', label: 'Queue', icon: ListMusic },
  { tab: 'activity', label: 'Activity', icon: Activity },
];

function MobileTabs() {
  const tab = useStore((s) => s.mobileTab);
  const queueLen = useStore((s) => s.player?.queue.length ?? 0);
  return (
    <nav className="relative z-20 grid grid-cols-3 border-t border-white/5 bg-ink-900/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl lg:hidden">
      {MOBILE_TABS.map(({ tab: t, label, icon: Icon }) => (
        <button
          key={t}
          type="button"
          onClick={() => set({ mobileTab: t })}
          className={cn('relative flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium', tab === t ? 'text-white' : 'text-zinc-500')}
        >
          <Icon size={20} className={tab === t ? 'text-accent' : ''} />
          {label}
          {t === 'queue' && queueLen > 0 && (
            <span className="absolute left-1/2 top-1 ml-2 rounded-full bg-brand px-1.5 text-[10px] tabular-nums text-white">{queueLen}</span>
          )}
        </button>
      ))}
    </nav>
  );
}

function MobileDrawer() {
  const open = useStore((s) => s.drawerOpen);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 animate-fade-in bg-black/60 backdrop-blur-sm lg:hidden" onClick={() => set({ drawerOpen: false })}>
      <div className="h-full w-72 max-w-[85vw] animate-pop border-r border-white/10 bg-ink-900" onClick={(e) => e.stopPropagation()}>
        <Sidebar />
      </div>
    </div>
  );
}

export function App() {
  const auth = useStore((s) => s.auth);
  useEffect(() => {
    void checkAuth();
  }, []);
  if (auth === 'checking') {
    return (
      <div className="grid h-dvh place-items-center">
        <Loader2 className="animate-spin text-zinc-600" />
      </div>
    );
  }
  if (auth === 'anon') return <LoginScreen />;
  return <Player />;
}

function Player() {
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const mobileTab = useStore((s) => s.mobileTab);
  const voiceConnected = useStore((s) => s.player?.voice.connected);
  useShortcuts();
  useDocumentTitle();

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <Ambient />
      <div className="relative flex min-h-0 flex-1">
        <aside className="hidden w-64 shrink-0 border-r border-white/5 bg-ink-900/50 backdrop-blur-xl lg:block">
          <Sidebar />
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          {!isDesktop && (
            <header className="flex items-center justify-between border-b border-white/5 bg-ink-900/70 px-3 py-2 backdrop-blur-xl">
              <button type="button" className="rounded-full p-2 text-zinc-300 hover:bg-white/10" onClick={() => set({ drawerOpen: true })} aria-label="Menu">
                <Menu size={20} />
              </button>
              <Logo />
              <span className={cn('mr-2 size-2 rounded-full', voiceConnected ? 'bg-emerald-400' : 'bg-zinc-600')} title={voiceConnected ? 'Bot in voice' : 'Bot not in voice'} />
            </header>
          )}

          {(isDesktop || mobileTab === 'library') && (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <MainView />
            </div>
          )}
          {!isDesktop && mobileTab === 'queue' && (
            <div className="flex min-h-0 flex-1 flex-col pt-3">
              <MobileControls />
              <QueuePanel />
            </div>
          )}
          {!isDesktop && mobileTab === 'activity' && (
            <div className="min-h-0 flex-1 overflow-y-auto pt-3">
              <ActivityFeed />
            </div>
          )}
        </main>

        {isDesktop && <SidePanel />}
      </div>

      <PlayerBar />
      {!isDesktop && <MobileTabs />}
      {!isDesktop && <MobileDrawer />}

      <AddUrlDialog />
      <Toaster theme="dark" position={isDesktop ? 'bottom-right' : 'top-center'} offset={isDesktop ? 104 : 16} closeButton toastOptions={{ duration: 3500 }} />
    </div>
  );
}
