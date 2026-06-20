export interface ReleaseNoteGroup {
  label: string;
  items: string[];
}

export interface ReleaseNote {
  version: string;
  title: string;
  groups: ReleaseNoteGroup[];
  /** Type-agnostic "…and N more changes" line, rendered below the groups when the entry is truncated. */
  overflowNote?: string;
}
