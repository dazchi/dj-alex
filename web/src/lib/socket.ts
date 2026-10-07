import { io } from 'socket.io-client';
import { toast } from 'sonner';
import type { AckResult, ClientActions, WebUser } from '../types';
import { set, useStore } from './store';

/** Connected only once the user is logged in (the server rejects anonymous sockets). */
export const socket = io({ transports: ['websocket', 'polling'], autoConnect: false });

socket.on('connect', () => set({ connected: true }));

socket.on('disconnect', () => set({ connected: false }));

socket.on('connect_error', (err) => {
  if (err.message === 'unauthorized') {
    socket.disconnect();
    set({ auth: 'anon', me: null });
  }
});

socket.on('state', (player) => set({ player, receivedAt: Date.now() }));

socket.on('activity:init', (activity) => set({ activity }));

/** Activity kinds that are too chatty to pop a toast for. */
const QUIET = ['volume', 'seek', 'move', 'repeat'];

socket.on('activity', (event) => {
  set((s) => ({ activity: [event, ...s.activity.filter((a) => a.id !== event.id)].slice(0, 100) }));
  const me = useStore.getState().me;
  if (event.userId !== me?.id && !QUIET.includes(event.kind ?? '')) {
    toast(event.user, { description: event.message, id: event.id });
  }
});

socket.on('presence', (presence) => set({ presence }));

socket.on('library', (library) =>
  set((s) => ({
    library,
    libraryVersion: s.library && library.lastScan !== s.library.lastScan ? s.libraryVersion + 1 : s.libraryVersion,
  })),
);

/** Checks the session cookie; connects the socket when logged in. */
export async function checkAuth() {
  try {
    const res = await fetch('/api/me');
    if (res.ok) {
      const me = (await res.json()) as WebUser;
      set({ auth: 'authed', me });
      if (!socket.connected) socket.connect();
      return;
    }
    const body = (await res.json().catch(() => ({}))) as { loginConfigured?: boolean };
    set({ auth: 'anon', me: null, loginConfigured: body.loginConfigured ?? true });
  } catch {
    // Server unreachable: retry shortly.
    setTimeout(checkAuth, 3000);
  }
}

export function login() {
  window.location.href = '/auth/login';
}

export async function logout() {
  await fetch('/auth/logout', { method: 'POST' }).catch(() => {});
  socket.disconnect();
  set({ auth: 'anon', me: null, player: null, activity: [], presence: [] });
}

/** Emits a player/queue action and toasts any error. Resolves to whether it succeeded. */
export function act<K extends keyof ClientActions>(event: K, payload?: ClientActions[K]): Promise<boolean> {
  return new Promise((resolve) => {
    socket.timeout(30_000).emit(event, payload ?? {}, (err: Error | null, res?: AckResult) => {
      if (err) {
        toast.error(socket.connected ? 'The server did not respond' : 'Not connected to the server');
        resolve(false);
      } else if (!res?.ok) {
        toast.error(res?.error ?? 'Something went wrong');
        resolve(false);
      } else resolve(true);
    });
  });
}
