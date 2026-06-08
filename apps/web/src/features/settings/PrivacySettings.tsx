import { useState } from 'react';
import { SettingsRow } from '../ui';

type PrivacyOption = 'readReceipts' | 'typingIndicators' | 'linkPreviews';

const privacyRows: Array<{ id: PrivacyOption; title: string }> = [
  { id: 'readReceipts', title: 'Read receipts' },
  { id: 'typingIndicators', title: 'Typing indicators' },
  { id: 'linkPreviews', title: 'Link previews' },
];

export function PrivacySettings() {
  const [settings, setSettings] = useState<Record<PrivacyOption, boolean>>({
    readReceipts: true,
    typingIndicators: true,
    linkPreviews: true,
  });

  const toggle = (id: PrivacyOption): void => {
    setSettings((current) => ({ ...current, [id]: !current[id] }));
  };

  return (
    <div className="space-y-3">
      {privacyRows.map((row) => (
        <SettingsRow
          key={row.id}
          title={row.title}
          value={settings[row.id] ? 'On' : 'Off'}
          enabled={settings[row.id]}
          onClick={() => toggle(row.id)}
        />
      ))}
    </div>
  );
}
