import { IconButton } from '@argus/web';
import { MoreVertical, Paperclip, Trash2 } from 'lucide-react';

// IconButton's ghost/subtle variants use translucent white icon colors, designed to sit on the
// app's dark shell (App.tsx's `bg-[#12121a]` panel) — never a bare page.
const shell = { background: '#12121a', padding: 16, borderRadius: 12 };

export function Variants() {
  return (
    <div style={{ ...shell, display: 'flex', gap: 12 }}>
      <IconButton aria-label="More options" variant="ghost">
        <MoreVertical className="h-5 w-5" />
      </IconButton>
      <IconButton aria-label="Attach file" variant="subtle">
        <Paperclip className="h-5 w-5" />
      </IconButton>
      <IconButton aria-label="Delete message" variant="danger">
        <Trash2 className="h-5 w-5" />
      </IconButton>
    </div>
  );
}

export function Sizes() {
  return (
    <div style={{ ...shell, display: 'flex', alignItems: 'center', gap: 12 }}>
      <IconButton aria-label="More options" size="xs">
        <MoreVertical className="h-3.5 w-3.5" />
      </IconButton>
      <IconButton aria-label="More options" size="sm">
        <MoreVertical className="h-4 w-4" />
      </IconButton>
      <IconButton aria-label="More options" size="md">
        <MoreVertical className="h-5 w-5" />
      </IconButton>
      <IconButton aria-label="More options" size="lg">
        <MoreVertical className="h-6 w-6" />
      </IconButton>
    </div>
  );
}

export function Disabled() {
  return (
    <div style={shell}>
      <IconButton aria-label="Delete message" variant="danger" disabled>
        <Trash2 className="h-5 w-5" />
      </IconButton>
    </div>
  );
}
