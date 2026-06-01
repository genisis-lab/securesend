interface Props {
  /** Navigate to the home view. */
  onHome: () => void;
  /** Whether we're already on the home view (hides the Home button there). */
  isHome: boolean;
  /** Show an "Install" entry point in the header (capable, not-yet-installed). */
  showInstall?: boolean;
  /** Show a transient "✓ Installed" confirmation instead of the install button. */
  justInstalled?: boolean;
  /** Click handler for the header Install button. */
  onInstall?: () => void;
}

/**
 * Hero header — a polished, dependency-free adaptation of a 21st.dev hero
 * block (badge + gradient title + ambient glow), restyled to match SecureSend's
 * dark theme and vanilla-CSS setup.
 *
 * The brand block doubles as a Home button (click the logo/title to go home),
 * and an explicit "Home" button appears when the user is off the home view.
 */
export function Hero({ onHome, isHome, showInstall, justInstalled, onInstall }: Props) {
  return (
    <header className="hero">
      <div className="hero__glow" aria-hidden />

      <div className="hero__bar">
        <button
          type="button"
          className="brand brand--button"
          onClick={onHome}
          aria-label="SecureSend home"
        >
          <div className="brand__logo">🔐</div>
          <div className="brand__text">
            <div className="brand__title">SecureSend</div>
            <div className="brand__sub">Encrypted P2P file transfer</div>
          </div>
        </button>

        <div className="row u-gap-8">
          {justInstalled ? (
            <span className="installed-badge" role="status" aria-live="polite">
              <span aria-hidden>✓</span> Installed
            </span>
          ) : (
            showInstall && (
              <button
                type="button"
                className="btn btn--ghost home-btn"
                onClick={onInstall}
                aria-label="Install SecureSend app"
              >
                <span aria-hidden>📲</span> Install app
              </button>
            )
          )}
          {!isHome && (
            <button type="button" className="btn btn--ghost home-btn" onClick={onHome}>
              <span aria-hidden>🏠</span> Home
            </button>
          )}
        </div>
      </div>

      {isHome && (
        <div className="hero__intro">
          <span className="hero__badge">
            <span className="hero__badge-dot" /> End-to-end encrypted · zero server storage
          </span>
          <h1 className="hero__headline">
            Send files that <span className="hero__headline-accent">only</span> your
            recipient can open
          </h1>
          <p className="hero__lead">
            Files are encrypted in your browser and streamed directly,
            peer-to-peer. No uploads, no server copies — just a private link.
          </p>
        </div>
      )}
    </header>
  );
}
