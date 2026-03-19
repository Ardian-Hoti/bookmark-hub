// BookmarkHub – background service worker
// Handles extension lifecycle events.

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    // Open the new tab on first install so user sees the extension immediately
    chrome.tabs.create({ url: 'chrome://newtab/' });
  }
});
