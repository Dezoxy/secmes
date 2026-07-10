import { Button } from '@argus/web';

export function Variants() {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
      <Button variant="primary">Send message</Button>
      <Button variant="subtle">Add to group</Button>
      <Button variant="ghost">Cancel</Button>
      <Button variant="danger">Leave conversation</Button>
    </div>
  );
}

export function Sizes() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <Button variant="primary" size="sm">
        Verify
      </Button>
      <Button variant="primary" size="md">
        Verify device
      </Button>
      <Button variant="primary" size="lg">
        Verify device
      </Button>
    </div>
  );
}

export function LoadingAndDisabled() {
  return (
    <div style={{ display: 'flex', gap: 12 }}>
      <Button variant="primary" loading loadingLabel="Sending…">
        Send message
      </Button>
      <Button variant="primary" disabled>
        Send message
      </Button>
    </div>
  );
}
