import { useState } from "react";

import { useNewVersion } from "../core/version";
import { CloseIcon } from "../ui/icons";
import "./update.css";

/**
 * "A new version is ready", once a deploy has put one on the server.
 *
 * It asks rather than reloads: a page that refreshed itself would do it in the middle of someone
 * reading a chain, and a desk is not somewhere surprises belong. Dismissing it is final for this
 * build — the next deploy asks again.
 *
 * The layout, the picks and the canvas all live in localStorage, so a refresh brings the desk back
 * as it was; the toast says so, because that is the thing that makes people hesitate.
 */
export function UpdateToast() {
  const newer = useNewVersion();
  const [hidden, setHidden] = useState(false);
  if (!newer || hidden) return null;
  return (
    <div className="mh-update" role="status">
      <span className="mh-update-dot" aria-hidden />
      <span className="mh-update-text">
        <span className="mh-update-title">A new version of AlphaHedge is ready</span>
        <em>Your layout and picks are saved — refreshing keeps them.</em>
      </span>
      <button type="button" className="mh-btn mh-update-go" onClick={() => location.reload()}>
        Refresh
      </button>
      <button type="button" className="mh-update-close" aria-label="Not now" title="Not now" onClick={() => setHidden(true)}>
        <CloseIcon size={11} />
      </button>
    </div>
  );
}
