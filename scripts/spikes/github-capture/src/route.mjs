// Scout Phase 0 GitHub capture spike: the issue-route gate.
//
// Only https://github.com/<owner>/<repo>/issues/<number> (optional trailing
// slash) is an issue page. Everything else is observed for URL changes only.
// The canonical issue URL drops query and fragment; the full href is kept
// internally (never stored or forwarded) as the navigation identity.

export const ISSUE_PATH_RE = /^\/[^/]+\/[^/]+\/issues\/\d+\/?$/;

/** @returns {{owner:string, repo:string, number:number, key:string, canonicalUrl:string} | null} */
export function parseIssueRoute(href) {
  let u;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.hostname !== "github.com" || u.port !== "" || u.username || u.password) return null;
  if (!ISSUE_PATH_RE.test(u.pathname)) return null;
  const [, owner, repo, , num] = u.pathname.split("/");
  const number = Number(num);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  const key = `${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`;
  return { owner, repo, number, key, canonicalUrl: `https://github.com/${owner}/${repo}/issues/${number}` };
}

export function isIssueUrl(href) {
  return parseIssueRoute(href) !== null;
}
