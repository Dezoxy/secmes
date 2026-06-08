import { SettingsRow } from '../ui';

export type PrivacyOption = 'readReceipts' | 'typingIndicators' | 'linkPreviews';
export type PrivacySettingsRecord = Record<PrivacyOption, boolean>;

export const DEFAULT_PRIVACY_SETTINGS: PrivacySettingsRecord = {
  readReceipts: true,
  typingIndicators: true,
  linkPreviews: true,
};

const privacyRows: Array<{ id: PrivacyOption; title: string }> = [
  { id: 'readReceipts', title: 'Read receipts' },
  { id: 'typingIndicators', title: 'Typing indicators' },
  { id: 'linkPreviews', title: 'Link previews' },
];

interface PrivacySettingsProps {
  settings: PrivacySettingsRecord;
  onSettingsChange: (settings: PrivacySettingsRecord) => void;
}

export function PrivacySettings({ settings, onSettingsChange }: PrivacySettingsProps) {
  const toggle = (id: PrivacyOption): void => {
    onSettingsChange({ ...settings, [id]: !settings[id] });
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
