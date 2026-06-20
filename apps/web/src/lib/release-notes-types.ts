export interface ReleaseNoteGroup {
  label: string;
  items: string[];
}

export interface ReleaseNote {
  version: string;
  title: string;
  groups: ReleaseNoteGroup[];
}
