import { Monitor } from 'lucide-react';
import { SettingsRow, StateBlock } from '../ui';

export function AboutSettings() {
  return (
    <div className="space-y-3">
      <SettingsRow title="App" value="Argus secure messaging" enabled />
      <SettingsRow title="Backend status" value="Diagnostics menu reserved" />
      <StateBlock icon={Monitor} title="Safe diagnostic export">
        Menu item is in place. We can wire the backend setting in the next pass.
      </StateBlock>
    </div>
  );
}
