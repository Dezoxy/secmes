// Persists the last-selected conversation per bottom-nav tab path across route remounts.
// React Router unmounts the route component on every tab switch; this map lets screens restore
// which conversation was open when the user returns to a tab.
export const tabSelectedId = new Map<string, string | null>();
