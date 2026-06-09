interface ArgusAppIconProps {
  className?: string;
}

export function ArgusAppIcon({ className = 'h-8 w-8 rounded-lg' }: ArgusAppIconProps) {
  return (
    <img
      src="/icon.svg"
      alt=""
      aria-hidden="true"
      className={`shrink-0 ${className}`}
      draggable={false}
    />
  );
}
