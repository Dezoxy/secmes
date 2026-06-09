import { APP_VERSION_TAG } from './app-version';

export interface ReleaseNote {
  version: string;
  title: string;
  items: string[];
}

export const releaseNotes: ReleaseNote[] = [
  {
    version: APP_VERSION_TAG,
    title: 'About screen polish',
    items: [
      'Backend status is shown as Online or Offline.',
      'The app version sits at the bottom of About.',
      'Release notes now have a dedicated scrollable area.',
    ],
  },
];
