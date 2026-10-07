import { Activity, Bot } from 'lucide-react';
import { useStore } from '../lib/store';
import { timeAgo, useNow } from '../lib/util';
import { Avatar, EmptyState } from './ui';

const SYSTEM = 'DJ Alex';

export function ActivityFeed() {
  const activity = useStore((s) => s.activity);
  const now = useNow();
  if (activity.length === 0) {
    return <EmptyState icon={<Activity size={24} />} title="No activity yet">What everyone does with the queue shows up here.</EmptyState>;
  }
  return (
    <ol className="flex flex-col gap-1 px-3 pb-4">
      {activity.map((e) => (
        <li key={e.id} className="flex gap-3 rounded-xl px-2 py-2 hover:bg-white/[0.04]">
          {e.user === SYSTEM ? (
            <div className="grid size-7 shrink-0 place-items-center rounded-full bg-brand">
              <Bot size={14} />
            </div>
          ) : (
            <Avatar name={e.user} src={e.avatar} className="size-7 shrink-0" />
          )}
          <div className="min-w-0 text-sm leading-snug">
            <span className="font-semibold text-zinc-100">{e.user}</span> <span className="text-zinc-400">{e.message}</span>
            <div className="mt-0.5 text-[11px] text-zinc-600">{timeAgo(e.at, now)}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}
