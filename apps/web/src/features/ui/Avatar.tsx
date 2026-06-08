import { safeAvatarSrc } from '../chat/seed';

type AvatarSize = 'sm' | 'md' | 'lg' | 'xl';

interface AvatarProps {
  name: string;
  src?: string;
  size?: AvatarSize;
  className?: string;
  imageClassName?: string;
}

const sizes: Record<AvatarSize, string> = {
  sm: 'h-8 w-8',
  md: 'h-10 w-10',
  lg: 'h-12 w-12',
  xl: 'h-20 w-20',
};

function joinClasses(...classes: Array<string | false | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

export function Avatar({ name, src, size = 'md', className, imageClassName }: AvatarProps) {
  return (
    <div className={joinClasses(sizes[size], 'overflow-hidden rounded-2xl', className)}>
      <img
        src={safeAvatarSrc(src, name)}
        alt={name}
        className={joinClasses('h-full w-full object-cover', imageClassName)}
      />
    </div>
  );
}
