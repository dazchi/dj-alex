import { create } from 'zustand';
import type { ActivityEvent, Actor, LibraryStats, PlayerState, WebUser } from '../types';

export type View = 'songs' | 'albums' | 'history';
export type MobileTab = 'library' | 'queue' | 'activity';
export type SidePanel = 'queue' | 'activity';

export type AuthState = 'checking' | 'anon' | 'authed';

interface AppStore {
  connected: boolean;
  player: PlayerState | null;
  /** Local Date.now() when `player` arrived; used to interpolate the playhead. */
  receivedAt: number;
  activity: ActivityEvent[];
  presence: Actor[];
  library: LibraryStats | null;
  /** Bumped whenever the library contents change so views refetch. */
  libraryVersion: number;
  auth: AuthState;
  me: WebUser | null;
  loginConfigured: boolean;
  view: View;
  albumKey: string | null;
  mobileTab: MobileTab;
  sidePanel: SidePanel;
  urlDialogOpen: boolean;
  drawerOpen: boolean;
}

export const useStore = create<AppStore>(() => ({
  connected: false,
  player: null,
  receivedAt: 0,
  activity: [],
  presence: [],
  library: null,
  libraryVersion: 0,
  auth: 'checking',
  me: null,
  loginConfigured: true,
  view: 'songs',
  albumKey: null,
  mobileTab: 'library',
  sidePanel: 'queue',
  urlDialogOpen: false,
  drawerOpen: false,
}));

export const set = useStore.setState;

export function navigate(view: View, albumKey: string | null = null) {
  set({ view, albumKey, mobileTab: 'library', drawerOpen: false });
}
