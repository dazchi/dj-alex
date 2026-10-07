import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Music } from 'lucide-react';
import { cn, colorFor, hashString, initials } from '../lib/util';

const GRADIENTS = [
  ['#7c3aed', '#ec4899'],
  ['#0ea5e9', '#6366f1'],
  ['#10b981', '#0ea5e9'],
  ['#f59e0b', '#ef4444'],
  ['#8b5cf6', '#06b6d4'],
  ['#f43f5e', '#a855f7'],
  ['#14b8a6', '#84cc16'],
];

/** Album art with a generated gradient fallback. */
export function Cover({
  coverId,
  seed,
  className,
  iconSize = 18,
}: {
  coverId: string | null | undefined;
  seed: string;
  className?: string;
  iconSize?: number;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [coverId]);
  const base = cn('shrink-0 overflow-hidden bg-ink-800', className);
  if (coverId && !failed) {
    return (
      <div className={base}>
        <img
          src={`/api/cover/${coverId}`}
          alt=""
          loading="lazy"
          draggable={false}
          onError={() => setFailed(true)}
          className="size-full object-cover"
        />
      </div>
    );
  }
  const [a, b] = GRADIENTS[hashString(seed) % GRADIENTS.length]!;
  return (
    <div className={cn(base, 'grid place-items-center')} style={{ background: `linear-gradient(135deg, ${a}, ${b})` }}>
      <Music size={iconSize} className="text-white/70" />
    </div>
  );
}

export function Avatar({ name, src, className }: { name: string; src?: string | null; className?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (src && !failed) {
    return (
      <img
        src={src}
        alt={name}
        title={name}
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className={cn('rounded-full bg-ink-700 object-cover', className)}
      />
    );
  }
  return (
    <div
      title={name}
      className={cn('grid place-items-center rounded-full text-[10px] font-semibold text-white', className)}
      style={{ background: colorFor(name) }}
    >
      {initials(name)}
    </div>
  );
}

export function IconButton({
  label,
  active,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={cn(
        'focus-ring grid place-items-center rounded-full transition disabled:pointer-events-none disabled:opacity-30',
        active ? 'text-accent' : 'text-zinc-400 hover:text-white',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Button({
  variant = 'ghost',
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'subtle' | 'danger' }) {
  return (
    <button
      type="button"
      className={cn(
        'focus-ring inline-flex items-center justify-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40',
        variant === 'primary' && 'bg-brand text-white shadow-lg shadow-fuchsia-900/30 hover:brightness-110',
        variant === 'ghost' && 'text-zinc-300 hover:bg-white/8 hover:text-white',
        variant === 'subtle' && 'bg-white/8 text-zinc-100 hover:bg-white/12',
        variant === 'danger' && 'bg-red-500/15 text-red-300 hover:bg-red-500/25',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/** Animated equalizer bars shown next to the playing track. */
export function Equalizer({ playing, className }: { playing: boolean; className?: string }) {
  return (
    <div className={cn('flex h-3.5 items-end gap-[2px]', className)} aria-hidden>
      {[0, 0.25, 0.5].map((delay) => (
        <span
          key={delay}
          className={cn('w-[3px] origin-bottom rounded-sm bg-accent', playing ? 'animate-eq' : 'scale-y-50')}
          style={{ height: '100%', animationDelay: `${delay}s` }}
        />
      ))}
    </div>
  );
}

/** Pointer-driven slider (seek bar / volume). Calls onChange while dragging and onCommit on release. */
export function Slider({
  value,
  max,
  onChange,
  onCommit,
  label,
  className,
  disabled,
  step,
}: {
  value: number;
  max: number;
  onChange?: (v: number) => void;
  onCommit: (v: number) => void;
  label: string;
  className?: string;
  disabled?: boolean;
  step?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const shown = drag ?? value;
  const pct = max > 0 ? Math.min(100, Math.max(0, (shown / max) * 100)) : 0;

  const fromEvent = (clientX: number) => {
    const rect = ref.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * max;
  };

  return (
    <div
      ref={ref}
      role="slider"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.round(shown)}
      tabIndex={disabled ? -1 : 0}
      className={cn(
        'focus-ring group relative flex h-4 cursor-pointer touch-none items-center rounded-full',
        disabled && 'pointer-events-none opacity-40',
        className,
      )}
      onPointerDown={(e) => {
        if (disabled || max <= 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        const v = fromEvent(e.clientX);
        setDrag(v);
        onChange?.(v);
      }}
      onPointerMove={(e) => {
        if (drag === null) return;
        const v = fromEvent(e.clientX);
        setDrag(v);
        onChange?.(v);
      }}
      onPointerUp={(e) => {
        if (drag === null) return;
        const v = fromEvent(e.clientX);
        setDrag(null);
        onCommit(v);
      }}
      onPointerCancel={() => setDrag(null)}
      onKeyDown={(e) => {
        const s = step ?? max / 20;
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') onCommit(Math.min(max, value + s));
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') onCommit(Math.max(0, value - s));
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <div className="relative h-1 w-full overflow-hidden rounded-full bg-white/12 transition-[height] group-hover:h-1.5">
        <div
          className={cn('absolute inset-y-0 left-0 rounded-full', drag !== null ? 'bg-brand' : 'bg-zinc-200 group-hover:bg-brand')}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div
        className={cn(
          'absolute size-3 -translate-x-1/2 rounded-full bg-white shadow-md shadow-black/50 transition-opacity',
          drag !== null ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100',
        )}
        style={{ left: `${pct}%` }}
      />
    </div>
  );
}

export function Modal({ open, onClose, children, title }: { open: boolean; onClose: () => void; children: ReactNode; title: string }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 grid animate-fade-in place-items-center bg-black/60 p-4 backdrop-blur-sm" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal
        aria-label={title}
        className="w-full max-w-md animate-pop rounded-3xl border border-white/10 bg-ink-850/95 p-6 shadow-2xl shadow-black/60"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-lg font-semibold">{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <div className="grid size-14 place-items-center rounded-2xl bg-white/5 text-zinc-500">{icon}</div>
      <p className="font-medium text-zinc-200">{title}</p>
      {children && <div className="max-w-xs text-sm text-zinc-500">{children}</div>}
    </div>
  );
}
