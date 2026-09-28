// Scout Phase 0 GitHub capture spike: the throwaway MV3 manifest.
// GitHub access is OPTIONAL and requested at runtime from the popup only. No
// <all_urls>, no tabs/history/webNavigation, no static content scripts.

export function buildManifest({ key } = {}) {
  const m = {
    manifest_version: 3,
    name: "Scout GitHub capture spike (Phase 0, throwaway)",
    version: "0.0.1",
    description: "Throwaway spike: captures the title and body of the GitHub issue in the active tab and sends them to a local test bridge.",
    minimum_chrome_version: "116",
    incognito: "not_allowed",
    permissions: ["scripting", "nativeMessaging", "storage"],
    optional_host_permissions: ["https://github.com/*"],
    background: { service_worker: "background.js", type: "module" },
    action: { default_title: "Scout capture spike", default_popup: "popup.html" },
  };
  if (key) m.key = key;
  return m;
}
