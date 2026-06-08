import { safeAvatarSrc } from '../chat/seed';

type AvatarSize = 'sm' | 'md' | 'lg' | 'xl';
type AvatarShape = 'rounded' | 'circle';

interface AvatarProps {
  name: string;
  src?: string;
  size?: AvatarSize;
  shape?: AvatarShape;
  className?: string;
  imageClassName?: string;
}

const sizes: Record<AvatarSize, string> = {
  sm: 'h-8 w-8',
  md: 'h-10 w-10',
  lg: 'h-12 w-12',
  xl: 'h-20 w-20',
};

const shapes: Record<AvatarShape, string> = {
  rounded: 'rounded-2xl',
  circle: 'rounded-full',
};

function joinClasses(...classes: Array<string | false | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

export function Avatar({
  name,
  src,
  size = 'md',
  shape = 'rounded',
  className,
  imageClassName,
}: AvatarProps) {
  return (
    <div className={joinClasses(sizes[size], shapes[shape], 'overflow-hidden', className)}>
      <img
        src={safeAvatarSrc(src, name)}
        alt={name}
        className={joinClasses('h-full w-full object-cover', imageClassName)}
      />
    </div>
  );
}
