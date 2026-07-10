import { V2CommandBar } from '@argus/web';

export function Default() {
  return (
    <div style={{ width: 420 }}>
      <V2CommandBar />
    </div>
  );
}

export function CustomPlaceholder() {
  return (
    <div style={{ width: 420 }}>
      <V2CommandBar placeholder="Jump by intent — privacy, storage, profile, recovery" />
    </div>
  );
}
