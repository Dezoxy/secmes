import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

interface StateBlockProps {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
  className?: string;
}

function joinClasses(...classes: Array<string | false | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

export function StateBlock({ icon: Icon, title, children, className }: StateBlockProps) {
  return (
    <div
      className={joinClasses(
        'rounded-xl border border-dashed border-white/10 bg-white/[0.02] p-4',
        className,
      )}
    >
      <div className="mb-2 flex items-center gap-2 text-sm font-medium text-white">
        <Icon className="h-4 w-4 text-purple-300" />
        {title}
      </div>
      <div className="text-sm leading-6 text-white/45">{children}</div>
    </div>
  );
}
