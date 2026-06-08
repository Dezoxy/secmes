import { Monitor } from 'lucide-react';
import { APP_VERSION_TAG } from '../../lib/app-version';
import { SettingsRow, StateBlock } from '../ui';

export function AboutSettings() {
  return (
    <div className="space-y-3">
      <SettingsRow title="App" value="Argus secure messaging" enabled />
      <SettingsRow title="Version" value={APP_VERSION_TAG} />
      <SettingsRow title="Backend status" value="Diagnostics menu reserved" />
      <StateBlock icon={Monitor} title="Safe diagnostic export">
        Menu item is in place. We can wire the backend setting in the next pass.
      </StateBlock>
    </div>
  );
}
