import { useState, type FormEvent } from 'react';
import { CloudDownload, ListEnd, ListStart, Play } from 'lucide-react';
import { toast } from 'sonner';
import type { InsertPosition } from '../types';
import { act } from '../lib/socket';
import { set, useStore } from '../lib/store';
import { cn } from '../lib/util';
import { Button, Modal } from './ui';

const input =
  'h-11 w-full rounded-xl border border-white/10 bg-white/5 px-4 text-[15px] text-white outline-none placeholder:text-zinc-500 focus:border-accent/60 focus:ring-4 focus:ring-accent/10';

const POSITIONS: { value: InsertPosition; label: string; icon: typeof Play }[] = [
  { value: 'end', label: 'End of queue', icon: ListEnd },
  { value: 'next', label: 'Play next', icon: ListStart },
  { value: 'now', label: 'Play now', icon: Play },
];

export function AddUrlDialog() {
  const open = useStore((s) => s.urlDialogOpen);
  const [url, setUrl] = useState('');
  const [position, setPosition] = useState<InsertPosition>('end');
  const [busy, setBusy] = useState(false);
  const close = () => set({ urlDialogOpen: false });

  let valid = false;
  try {
    valid = ['http:', 'https:'].includes(new URL(url.trim()).protocol);
  } catch {
    /* invalid */
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    const ok = await act('queue:addUrl', { url: url.trim(), position });
    setBusy(false);
    if (ok) {
      toast.success('Downloading and adding to the queue');
      setUrl('');
      close();
    }
  };

  return (
    <Modal open={open} title="Add from URL" onClose={close}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <p className="text-sm text-zinc-400">
          Paste a direct link to an audio file (mp3, flac, ogg, m4a, wav…). The server downloads it, then plays it like any other track.
        </p>
        <input
          autoFocus
          className={input}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com/song.mp3"
          inputMode="url"
        />
        <div className="grid grid-cols-3 gap-2">
          {POSITIONS.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              type="button"
              onClick={() => setPosition(value)}
              className={cn(
                'flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-xs font-medium transition',
                position === value ? 'border-accent/70 bg-accent/10 text-white' : 'border-white/8 text-zinc-400 hover:border-white/20 hover:text-white',
              )}
            >
              <Icon size={18} />
              {label}
            </button>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!valid || busy}>
            <CloudDownload size={16} /> Add
          </Button>
        </div>
      </form>
    </Modal>
  );
}
